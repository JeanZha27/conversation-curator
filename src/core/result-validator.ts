import { CuratorError } from "./errors.ts";
import { scanSensitiveText } from "./security-scanner.ts";
import { ACTIVE_TAXONOMY_IDS, categoryById } from "./taxonomy.ts";
import type { ClassificationResult, SensitivityLevel } from "../types.ts";

const LIFECYCLE = new Set(["active", "pending", "completed", "archived"]);
const VALUE_LEVEL = new Set(["V0", "V1", "V2", "V3"]);
const SENSITIVITY = new Set(["S0", "S1", "S2", "S3"]);
const TITLE_STATUS = new Set(["进行中", "待处理", "已完成", "已归档"]);
const CONFIDENCE_FIELDS = new Set(["primaryCategoryId", "lifecycleStatus", "suggestedTitle"]);
const RISK_FLAGS = new Set(["SENSITIVE_PATTERN", "S3_CANDIDATE"]);
const REASON_CODES = new Set([
  "LOW_CONFIDENCE",
  "MULTI_TOPIC",
  "SENSITIVE_PATTERN",
  "S3_CANDIDATE",
  "UNKNOWN_PROJECT",
  "BRANCH_FALLBACK",
  "EMPTY_CONTENT",
]);
const EXPECTED_FIELDS = new Set([
  "conversationId",
  "taxonomyVersion",
  "primaryCategoryId",
  "projectId",
  "intent",
  "deliverableType",
  "lifecycleStatus",
  "valueLevel",
  "sensitivityLevel",
  "suggestedTitle",
  "tags",
  "fieldConfidence",
  "riskFlags",
  "reasonCodes",
  "requiresReview",
  "classifierProvider",
  "classifierVersion",
  "createdAt",
]);
const SENSITIVITY_RANK: Record<SensitivityLevel, number> = { S0: 0, S1: 1, S2: 2, S3: 3 };

function isConfidenceMap(value: unknown): value is Record<string, number> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0 &&
    Object.values(value).every(
      (entry) => typeof entry === "number" && Number.isFinite(entry) && entry >= 0 && entry <= 1,
    )
  );
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function characterLength(value: string): number {
  return Array.from(value).length;
}

function hasSensitiveText(value: string): boolean {
  const scan = scanSensitiveText(value);
  return scan.hardMatch || scan.candidateMatch;
}

function validateSuggestedTitle(value: unknown, errors: string[]): void {
  if (typeof value !== "string" || !value) {
    errors.push("suggestedTitle 无效");
    return;
  }
  const length = characterLength(value);
  if (length < 16 || length > 30) errors.push("suggestedTitle 长度必须为 16–30 个字符");
  const match = value.match(/^\[[^\]\r\n]{2,12}\] .+ · (.+)$/u);
  if (!match || !match[1] || !TITLE_STATUS.has(match[1])) errors.push("suggestedTitle 格式或状态无效");
  if (hasSensitiveText(value)) errors.push("suggestedTitle 含敏感信息");
}

function validateTags(value: unknown, errors: string[]): void {
  if (!stringArray(value)) {
    errors.push("tags 无效");
    return;
  }
  if (value.length > 8) errors.push("tags 数量超过 8");
  value.forEach((tag, index) => {
    const length = characterLength(tag);
    if (length < 1 || length > 32) errors.push(`tags[${index}] 长度无效`);
    if (hasSensitiveText(tag)) errors.push(`tags[${index}] 含敏感信息`);
  });
}

export function validateClassification(
  value: unknown,
  constraints: { minimumSensitivity?: SensitivityLevel } = {},
): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["结果不是对象"];
  }
  const result = value as Partial<ClassificationResult>;
  const errors: string[] = [];
  const unknownFields = Object.keys(value).filter((field) => !EXPECTED_FIELDS.has(field));
  if (unknownFields.length > 0) errors.push(`包含未知字段：${unknownFields.join("、")}`);
  const missingFields = [...EXPECTED_FIELDS].filter((field) => !(field in value));
  if (missingFields.length > 0) errors.push(`缺少字段：${missingFields.join("、")}`);

  if (typeof result.conversationId !== "string" || !/^conv:(?:[a-f0-9]{8}:){7}[a-f0-9]{8}$/u.test(result.conversationId)) {
    errors.push("conversationId 必须是本地安全引用");
  }
  if (result.taxonomyVersion !== "mvp-1") errors.push("taxonomyVersion 无效");
  if (typeof result.primaryCategoryId !== "string" || !ACTIVE_TAXONOMY_IDS.has(result.primaryCategoryId)) {
    errors.push("primaryCategoryId 不存在或已废弃");
  }
  const category = typeof result.primaryCategoryId === "string" ? categoryById(result.primaryCategoryId) : undefined;
  if (result.projectId !== null) errors.push("projectId 必须为 null");
  if (typeof result.intent !== "string" || !result.intent) errors.push("intent 无效");
  if (typeof result.deliverableType !== "string" || !result.deliverableType) errors.push("deliverableType 无效");
  if (category && result.intent !== category.intent) errors.push("intent 与 taxonomy 不一致");
  if (category && result.deliverableType !== category.deliverableType) errors.push("deliverableType 与 taxonomy 不一致");
  if (category && result.valueLevel !== category.valueLevel) errors.push("valueLevel 与 taxonomy 不一致");
  if (!LIFECYCLE.has(result.lifecycleStatus ?? "")) errors.push("lifecycleStatus 无效");
  if (!VALUE_LEVEL.has(result.valueLevel ?? "")) errors.push("valueLevel 无效");
  if (!SENSITIVITY.has(result.sensitivityLevel ?? "")) errors.push("sensitivityLevel 无效");
  if (
    constraints.minimumSensitivity &&
    result.sensitivityLevel &&
    SENSITIVITY.has(result.sensitivityLevel) &&
    SENSITIVITY_RANK[result.sensitivityLevel] < SENSITIVITY_RANK[constraints.minimumSensitivity]
  ) {
    errors.push("sensitivityLevel 低于确定性扫描结果");
  }
  validateSuggestedTitle(result.suggestedTitle, errors);
  validateTags(result.tags, errors);
  if (!isConfidenceMap(result.fieldConfidence)) {
    errors.push("fieldConfidence 无效");
  } else if (Object.keys(result.fieldConfidence).some((field) => !CONFIDENCE_FIELDS.has(field))) {
    errors.push("fieldConfidence 包含未知字段");
  }
  if (
    !stringArray(result.riskFlags) ||
    result.riskFlags.length > 16 ||
    result.riskFlags.some((flag) => !RISK_FLAGS.has(flag))
  ) {
    errors.push("riskFlags 无效");
  }
  if (
    !stringArray(result.reasonCodes) ||
    result.reasonCodes.length > 16 ||
    result.reasonCodes.some((code) => !REASON_CODES.has(code))
  ) {
    errors.push("reasonCodes 无效");
  }
  if (typeof result.requiresReview !== "boolean") errors.push("requiresReview 无效");
  if (result.classifierProvider !== "heuristic-provider") errors.push("classifierProvider 无效");
  if (result.classifierVersion !== "mvp-1") errors.push("classifierVersion 无效");
  if (typeof result.createdAt !== "string" || Number.isNaN(Date.parse(result.createdAt))) errors.push("createdAt 无效");
  return errors;
}

export function assertValidClassification(
  value: unknown,
  constraints: { minimumSensitivity?: SensitivityLevel } = {},
): asserts value is ClassificationResult {
  const errors = validateClassification(value, constraints);
  if (errors.length > 0) {
    throw new CuratorError("CLASSIFICATION_INVALID", `分类结果校验失败：${errors.join("；")}`);
  }
}
