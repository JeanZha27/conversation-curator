import { CuratorError } from "../core/errors.ts";
import type { CanonicalConversation } from "../types.ts";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
  }
  return null;
}

type CanonicalMessage = {
  classificationText: string;
  securityText: string;
  createdAt: number;
};

const ATTACHMENT_METADATA_KEYS = new Set([
  "filename",
  "file_name",
  "fileName",
  "name",
  "content_type",
  "contentType",
  "mime_type",
  "mimeType",
]);
const MAX_CLASSIFICATION_MESSAGE_CHARACTERS = 32 * 1024;
export const MAX_MAPPING_NODES = 50_000;

function assertMappingNodeLimit(mapping: JsonRecord): void {
  let count = 0;
  for (const key in mapping) {
    if (!Object.hasOwn(mapping, key)) continue;
    count += 1;
    if (count > MAX_MAPPING_NODES) {
      throw new CuratorError(
        "MAPPING_NODE_LIMIT_EXCEEDED",
        `对话 mapping 节点超过 ${MAX_MAPPING_NODES.toLocaleString("en-US")} 个安全上限。`,
      );
    }
  }
}

function attachmentMetadata(value: unknown): string[] {
  if (!isRecord(value)) return [];

  return Object.entries(value).flatMap(([key, entry]) => {
    if (ATTACHMENT_METADATA_KEYS.has(key) && typeof entry === "string" && entry.trim()) {
      return [`attachment.${key}:${entry.trim()}`];
    }
    return [];
  });
}

function messageContent(node: unknown): CanonicalMessage | null {
  if (!isRecord(node) || !isRecord(node.message)) return null;
  const message = node.message;
  const parts = isRecord(message.content) && Array.isArray(message.content.parts)
    ? message.content.parts
    : [];
  const textParts = parts.filter((part): part is string => typeof part === "string");
  const visibleText = textParts.map((part) => part.trim()).filter(Boolean).join("\n").trim();
  const role = isRecord(message.author) && typeof message.author.role === "string"
    ? message.author.role
    : null;
  const hidden = isRecord(message.metadata) &&
    (message.metadata.is_visually_hidden_from_conversation === true || message.metadata.hidden === true);
  const classificationAllowed = !hidden && (role === null || role === "user" || role === "assistant");
  const classificationText = classificationAllowed ? visibleText : "";
  const metadata = [
    ...parts.flatMap((part) => isRecord(part) ? attachmentMetadata(part) : []),
    ...(isRecord(message.metadata) && Array.isArray(message.metadata.attachments)
      ? message.metadata.attachments.flatMap(attachmentMetadata)
      : []),
  ];
  // Scan the concatenated text parts as one logical message. Exporters may
  // split a credential at an arbitrary part boundary, where newline joining
  // would otherwise let it evade a deterministic detector.
  const securityBody = textParts.join("").trim();
  const securityText = [securityBody, ...metadata].filter(Boolean).join("\n");
  if (!securityText) return null;
  const createdAt = typeof message.create_time === "number" ? message.create_time : 0;
  return { classificationText, securityText, createdAt };
}

function currentBranchMessages(
  mapping: JsonRecord,
  currentNode: string,
): CanonicalMessage[] | null {
  const nodes: unknown[] = [];
  const visited = new Set<string>();
  let nodeId: string | null = currentNode;

  while (nodeId) {
    if (visited.has(nodeId)) {
      throw new CuratorError("INVALID_BRANCH", "对话分支包含循环引用。");
    }
    visited.add(nodeId);
    if (!Object.hasOwn(mapping, nodeId)) return null;
    const current: unknown = mapping[nodeId];
    if (!isRecord(current)) return null;
    nodes.push(current);
    if (current.parent === null || current.parent === undefined || current.parent === "") {
      nodeId = null;
    } else if (typeof current.parent === "string") {
      nodeId = current.parent;
    } else {
      throw new CuratorError("INVALID_BRANCH", "对话分支父节点引用无效。");
    }
  }

  return nodes.reverse().flatMap((node) => {
    const message = messageContent(node);
    return message ? [message] : [];
  });
}

function allMessages(mapping: JsonRecord): CanonicalMessage[] {
  return Object.values(mapping)
    .map(messageContent)
    .filter((message): message is CanonicalMessage => message !== null)
    .sort((left, right) => left.createdAt - right.createdAt);
}

function truncateClassificationText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_CLASSIFICATION_MESSAGE_CHARACTERS) {
    return { text, truncated: false };
  }
  const side = Math.floor(MAX_CLASSIFICATION_MESSAGE_CHARACTERS / 2);
  return {
    text: `${text.slice(0, side)}\n[CONTENT_TRUNCATED]\n${text.slice(-side)}`,
    truncated: true,
  };
}

function sampleMessages(messages: CanonicalMessage[]): { texts: string[]; truncated: boolean } {
  const validText = messages.map((message) => message.classificationText).filter(Boolean);
  const selected = validText.length <= 6
    ? validText
    : [...validText.slice(0, 3), ...validText.slice(-3)];
  let truncated = false;
  const texts = selected.map((text) => {
    const bounded = truncateClassificationText(text);
    truncated ||= bounded.truncated;
    return bounded.text;
  });
  return { texts, truncated };
}

export function parseChatGptConversation(value: unknown): CanonicalConversation {
  if (!isRecord(value)) {
    throw new CuratorError("INVALID_CONVERSATION", "对话项不是对象。");
  }

  const sourceConversationId =
    typeof value.id === "string" && value.id.trim()
      ? value.id.trim()
      : typeof value.conversation_id === "string" && value.conversation_id.trim()
        ? value.conversation_id.trim()
        : null;
  if (!sourceConversationId) {
    throw new CuratorError("MISSING_CONVERSATION_ID", "对话项缺少稳定 ID。");
  }
  if (!isRecord(value.mapping)) {
    throw new CuratorError("MISSING_MAPPING", "对话项缺少 mapping 对象。");
  }
  assertMappingNodeLimit(value.mapping);

  let branchMode: CanonicalConversation["branchMode"] = "all-messages-fallback";
  let messages: CanonicalMessage[] | null = null;
  if (typeof value.current_node === "string" && value.current_node) {
    messages = currentBranchMessages(value.mapping, value.current_node);
    if (messages) branchMode = "current";
  }
  if (!messages) messages = allMessages(value.mapping);

  const trimmedTitle = typeof value.title === "string" ? value.title.trim() : "";
  const title = trimmedTitle || "未命名对话";
  const boundedTitle = truncateClassificationText(title);
  const sampled = sampleMessages(messages);

  return {
    sourceConversationId,
    title,
    classificationTitle: boundedTitle.text,
    createdAt: normalizeTimestamp(value.create_time),
    updatedAt: normalizeTimestamp(value.update_time),
    messageCount: messages.length,
    contentAvailable: messages.some((message) => Boolean(message.classificationText)),
    classificationTruncated: boundedTitle.truncated || sampled.truncated,
    securityText: messages.map((message) => message.securityText),
    sampledText: sampled.texts,
    branchMode,
  };
}
