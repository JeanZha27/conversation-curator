import type {
  CanonicalConversation,
  ClassificationResult,
  LifecycleStatus,
  SecurityScan,
} from "../types.ts";
import { TAXONOMY, type Category } from "./taxonomy.ts";

export type ClassificationConversation = Pick<
  CanonicalConversation,
  "sourceConversationId" | "contentAvailable" | "classificationTruncated" | "branchMode"
>;

const CATEGORIES = TAXONOMY.filter((category) => category.id !== "other");
const OTHER = TAXONOMY.find((category) => category.id === "other")!;

function keywordMatches(text: string, keyword: string): boolean {
  if (!/^[a-z0-9_-]+$/u.test(keyword)) return text.includes(keyword);
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![a-z0-9_])${escaped}(?![a-z0-9_])`, "u").test(text);
}

function lifecycleStatus(text: string): LifecycleStatus {
  if (/(已完成|完成了|已解决|resolved|finished|done)/iu.test(text)) return "completed";
  if (/(等待|待办|稍后|pending|todo)/iu.test(text)) return "pending";
  if (/(归档|不再处理|archived)/iu.test(text)) return "archived";
  return "active";
}

function statusLabel(status: LifecycleStatus): string {
  return {
    active: "进行中",
    pending: "待处理",
    completed: "已完成",
    archived: "已归档",
  }[status];
}

function chooseCategory(text: string): {
  category: Category;
  score: number;
  tied: boolean;
} {
  const scored = CATEGORIES.map((category) => ({
    category,
    score: category.keywords.reduce(
      (total, keyword) => total + (keywordMatches(text, keyword.toLowerCase()) ? 1 : 0),
      0,
    ),
  })).sort((left, right) => right.score - left.score);
  const first = scored[0];
  if (!first || first.score === 0) return { category: OTHER, score: 0, tied: false };
  return {
    category: first.category,
    score: first.score,
    tied: scored[1]?.score === first.score,
  };
}

export function classifyConversation(
  conversation: ClassificationConversation,
  security: SecurityScan,
  now = new Date(),
): ClassificationResult {
  const searchableText = security.redactedText.toLowerCase();
  const selection = chooseCategory(searchableText);
  const status = lifecycleStatus(searchableText);
  const confidence = selection.score === 0 ? 0.3 : selection.tied ? 0.5 : selection.score === 1 ? 0.68 : 0.84;
  const fieldConfidence = {
    primaryCategoryId: confidence,
    lifecycleStatus: status === "active" ? 0.55 : 0.8,
    suggestedTitle: confidence,
  };
  const lowConfidence = Object.values(fieldConfidence).some((fieldValue) => fieldValue < 0.8);
  const reasonCodes = [
    "UNKNOWN_PROJECT",
    ...(lowConfidence ? ["LOW_CONFIDENCE"] : []),
    ...(selection.tied ? ["MULTI_TOPIC"] : []),
    ...security.riskFlags,
    ...(conversation.branchMode === "all-messages-fallback" ? ["BRANCH_FALLBACK"] : []),
    ...(!conversation.contentAvailable ? ["EMPTY_CONTENT"] : []),
    ...(conversation.classificationTruncated ? ["CONTENT_TRUNCATED"] : []),
  ];
  const requiresReview =
    confidence < 0.8 ||
    security.sensitivityLevel !== "S0" ||
    conversation.branchMode === "all-messages-fallback" ||
    !conversation.contentAvailable ||
    conversation.classificationTruncated ||
    lowConfidence;

  return {
    conversationId: conversation.sourceConversationId,
    taxonomyVersion: "mvp-1",
    primaryCategoryId: selection.category.id,
    projectId: null,
    intent: selection.category.intent,
    deliverableType: selection.category.deliverableType,
    lifecycleStatus: status,
    valueLevel: selection.category.valueLevel,
    sensitivityLevel: security.sensitivityLevel,
    suggestedTitle: `[${selection.category.label}] 整理${selection.category.titleObject} · ${statusLabel(status)}`,
    tags: [selection.category.id, status],
    fieldConfidence,
    riskFlags: [...security.riskFlags],
    reasonCodes: [...new Set(reasonCodes)],
    requiresReview,
    classifierProvider: "heuristic-provider",
    classifierVersion: "mvp-1",
    createdAt: now.toISOString(),
  };
}
