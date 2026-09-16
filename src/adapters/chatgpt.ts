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

function messageText(node: unknown): { text: string; createdAt: number } | null {
  if (!isRecord(node) || !isRecord(node.message)) return null;
  const message = node.message;
  if (!isRecord(message.content) || !Array.isArray(message.content.parts)) return null;
  const text = message.content.parts
    .filter((part): part is string => typeof part === "string")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!text) return null;
  const createdAt = typeof message.create_time === "number" ? message.create_time : 0;
  return { text, createdAt };
}

function currentBranchMessages(
  mapping: JsonRecord,
  currentNode: string,
): string[] | null {
  const nodes: unknown[] = [];
  const visited = new Set<string>();
  let nodeId: string | null = currentNode;

  while (nodeId) {
    if (visited.has(nodeId)) {
      throw new CuratorError("INVALID_BRANCH", "对话分支包含循环引用。");
    }
    visited.add(nodeId);
    const current: unknown = mapping[nodeId];
    if (!isRecord(current)) return null;
    nodes.push(current);
    nodeId = typeof current.parent === "string" && current.parent ? current.parent : null;
  }

  return nodes.reverse().flatMap((node) => {
    const message = messageText(node);
    return message ? [message.text] : [];
  });
}

function allMessages(mapping: JsonRecord): string[] {
  return Object.values(mapping)
    .map(messageText)
    .filter((message): message is { text: string; createdAt: number } => message !== null)
    .sort((left, right) => left.createdAt - right.createdAt)
    .map((message) => message.text);
}

function sampleMessages(messages: string[]): string[] {
  if (messages.length <= 6) return messages;
  return [...messages.slice(0, 3), ...messages.slice(-3)];
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

  let branchMode: CanonicalConversation["branchMode"] = "all-messages-fallback";
  let messages: string[] | null = null;
  if (typeof value.current_node === "string" && value.current_node) {
    messages = currentBranchMessages(value.mapping, value.current_node);
    if (messages) branchMode = "current";
  }
  if (!messages) messages = allMessages(value.mapping);

  const title = typeof value.title === "string" && value.title.trim() ? value.title.trim() : "未命名对话";

  return {
    sourceConversationId,
    title,
    createdAt: normalizeTimestamp(value.create_time),
    updatedAt: normalizeTimestamp(value.update_time),
    messageCount: messages.length,
    contentAvailable: messages.length > 0,
    sampledText: sampleMessages(messages),
    branchMode,
  };
}
