import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, open, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { parseChatGptConversation } from "../adapters/chatgpt.ts";
import type {
  ConversationReportItem,
  CuratorRunResult,
  ReportEvent,
  ReportHeaderEvent,
  ReportPrivacy,
  ReportSummary,
  SafeFailure,
} from "../types.ts";
import { CuratorError } from "./errors.ts";
import { classifyConversation } from "./heuristic-classifier.ts";
import { streamJsonObjectArray } from "./json-array-stream.ts";
import {
  assertOutputValueSafe,
  outputValueHasSensitiveData,
  safeConversationReference,
  safeSourceHash,
  sanitizeClassificationContext,
  sanitizeOutputValue,
} from "./output-sanitizer.ts";
import { assertValidClassification } from "./result-validator.ts";
import { scanSensitiveSegments } from "./security-scanner.ts";

const MAX_INPUT_BYTES = 256 * 1024 * 1024;
const MAX_CONVERSATIONS = 50_000;
const PREVIEW_CONVERSATIONS = 20;
const PREVIEW_FAILURES = 10;

type SourceInfo = {
  path: string;
  sizeBytes: number;
};

export type RunOptions = {
  inputPath: string;
  signal?: AbortSignal | undefined;
  now?: Date | undefined;
  onEvent?: ((event: ReportEvent) => Promise<void>) | undefined;
};

function abortError(): Error {
  const error = new Error("操作已取消。");
  error.name = "AbortError";
  return error;
}

async function validateSource(inputPath: string): Promise<SourceInfo> {
  const path = resolve(inputPath);
  if (extname(path).toLowerCase() !== ".json") {
    throw new CuratorError("INVALID_FILE_TYPE", "输入文件必须使用 .json 扩展名。");
  }

  let sourceStat;
  try {
    sourceStat = await stat(path);
    await access(path, constants.R_OK);
  } catch {
    throw new CuratorError("INPUT_NOT_READABLE", "输入文件不存在或不可读取。");
  }
  if (!sourceStat.isFile()) throw new CuratorError("INPUT_NOT_FILE", "输入路径不是普通文件。");
  if (sourceStat.size === 0) throw new CuratorError("INPUT_EMPTY", "输入文件为空。");
  if (sourceStat.size > MAX_INPUT_BYTES) {
    throw new CuratorError("INPUT_TOO_LARGE", "输入文件超过本轮 256 MiB 安全上限。");
  }
  return {
    path,
    sizeBytes: sourceStat.size,
  };
}

async function sha256File(filePath: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw abortError();
  const hash = createHash("sha256");
  const handle = await open(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      if (signal?.aborted) throw abortError();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

function safeFailure(index: number, error: unknown): SafeFailure {
  const safeErrors: Record<string, string> = {
    INVALID_CONVERSATION: "对话项不是受支持的对象。",
    MISSING_CONVERSATION_ID: "对话项缺少稳定 ID。",
    MISSING_MAPPING: "对话项缺少 mapping 对象。",
    INVALID_BRANCH: "对话分支结构无效。",
    CLASSIFICATION_INVALID: "分类结果未通过运行时校验。",
    OUTPUT_SANITIZATION_FAILED: "该项输出未通过隐私校验。",
  };
  if (error instanceof SyntaxError) {
    return { itemIndex: index, code: "INVALID_ITEM_JSON", message: "对话项 JSON 无法解析。" };
  }
  if (error instanceof CuratorError && Object.hasOwn(safeErrors, error.code)) {
    return { itemIndex: index, code: error.code, message: safeErrors[error.code]! };
  }
  return { itemIndex: index, code: "ITEM_PROCESSING_FAILED", message: "对话项处理失败。" };
}

async function emitSafely(
  event: ReportEvent,
  onEvent?: (event: ReportEvent) => Promise<void>,
): Promise<boolean> {
  const sensitive = outputValueHasSensitiveData(event);
  assertOutputValueSafe(event);
  await onEvent?.(event);
  return sensitive;
}

export async function runCurator(options: RunOptions): Promise<CuratorRunResult> {
  const source = await validateSource(options.inputPath);
  const beforeHash = await sha256File(source.path, options.signal);
  const generatedAt = (options.now ?? new Date()).toISOString();
  const header: ReportHeaderEvent = {
    type: "header",
    schemaVersion: "1.3",
    generatedAt,
    source: {
      platform: "chatgpt",
      // A source filename is user-controlled metadata and may itself contain
      // personal data. Keep the report useful without persisting that value.
      fileName: "conversations.json",
      sha256: safeSourceHash(beforeHash),
      sizeBytes: source.sizeBytes,
    },
  };

  let finalOutputSensitive = await emitSafely(header, options.onEvent);

  const previewConversations: ConversationReportItem[] = [];
  const previewFailures: SafeFailure[] = [];
  // Retain only irreversible references, not raw source IDs, for the duration
  // of the run.
  const seenConversationRefs = new Set<string>();
  let totalItems = 0;
  let classified = 0;
  let duplicates = 0;
  let failed = 0;
  let currentBranchParsed = 0;
  let branchFallbacks = 0;
  let contentUnavailable = 0;
  let classificationTruncated = 0;
  let s3 = 0;
  let s3Candidates = 0;
  let suggestedAccept = 0;
  let requiresReview = 0;

  for await (const item of streamJsonObjectArray(source.path, options.signal)) {
    totalItems += 1;
    if (totalItems > MAX_CONVERSATIONS) {
      throw new CuratorError(
        "CONVERSATION_LIMIT_EXCEEDED",
        "输入超过本轮 50,000 条对话上限；请拆分后重试。",
      );
    }
    let processed: {
      data: ConversationReportItem;
      candidateMatch: boolean;
      branchMode: ConversationReportItem["branchMode"];
      contentAvailable: boolean;
      classificationTruncated: boolean;
    } | null = null;
    try {
      const parsed = JSON.parse(item.raw) as unknown;
      const conversation = parseChatGptConversation(parsed);
      const conversationRef = safeConversationReference(conversation.sourceConversationId);
      const scan = scanSensitiveSegments([conversation.title, ...conversation.securityText]);
      if (seenConversationRefs.has(conversationRef)) {
        duplicates += 1;
        // Duplicates are not classified, but their content still contributes
        // to the security totals. The CLI marks any duplicate run as partial.
        if (scan.sensitivityLevel === "S3") s3 += 1;
        if (scan.candidateMatch) s3Candidates += 1;
        continue;
      }
      seenConversationRefs.add(conversationRef);

      const classificationContext = sanitizeClassificationContext(
        [conversation.classificationTitle, ...conversation.sampledText].join("\n"),
      );
      const classification = classifyConversation(
        {
          sourceConversationId: conversationRef,
          contentAvailable: conversation.contentAvailable,
          classificationTruncated: conversation.classificationTruncated,
          branchMode: conversation.branchMode,
        },
        { ...scan, redactedText: classificationContext },
        options.now ?? new Date(),
      );
      assertValidClassification(classification, {
        expectedConversationId: conversationRef,
        minimumSensitivity: scan.sensitivityLevel,
        expectedRiskFlags: scan.riskFlags,
        requiresReview:
          scan.sensitivityLevel === "S3" ||
          scan.candidateMatch ||
          conversation.branchMode === "all-messages-fallback" ||
          !conversation.contentAvailable ||
          conversation.classificationTruncated,
        requiredReasonCodes: [
          ...scan.riskFlags,
          ...(conversation.branchMode === "all-messages-fallback" ? ["BRANCH_FALLBACK"] : []),
          ...(!conversation.contentAvailable ? ["EMPTY_CONTENT"] : []),
          ...(conversation.classificationTruncated ? ["CONTENT_TRUNCATED"] : []),
        ],
      });
      const { redactedText: _discarded, ...safeSecurity } = scan;
      const sanitized = sanitizeOutputValue<ConversationReportItem>({
        conversationRef,
        messageCount: conversation.messageCount,
        branchMode: conversation.branchMode,
        classificationTruncated: conversation.classificationTruncated,
        security: safeSecurity,
        classification,
      });
      assertOutputValueSafe(sanitized.value);
      processed = {
        data: sanitized.value,
        candidateMatch: safeSecurity.candidateMatch,
        branchMode: conversation.branchMode,
        contentAvailable: conversation.contentAvailable,
        classificationTruncated: conversation.classificationTruncated,
      };
    } catch (error) {
      const failure = safeFailure(item.index, error);
      const sanitized = sanitizeOutputValue(failure);
      assertOutputValueSafe(sanitized.value);
      finalOutputSensitive ||=
        await emitSafely({ type: "failure", data: sanitized.value }, options.onEvent);
      failed += 1;
      if (previewFailures.length < PREVIEW_FAILURES) previewFailures.push(sanitized.value);
      continue;
    }

    finalOutputSensitive ||=
      await emitSafely({ type: "conversation", data: processed.data }, options.onEvent);
    classified += 1;
    if (processed.data.classification.sensitivityLevel === "S3") s3 += 1;
    if (processed.candidateMatch) s3Candidates += 1;
    if (processed.data.classification.requiresReview) requiresReview += 1;
    else suggestedAccept += 1;
    if (processed.branchMode === "all-messages-fallback") branchFallbacks += 1;
    if (!processed.contentAvailable) contentUnavailable += 1;
    if (processed.classificationTruncated) classificationTruncated += 1;
    if (processed.branchMode === "current" && processed.contentAvailable) {
      currentBranchParsed += 1;
    }
    if (previewConversations.length < PREVIEW_CONVERSATIONS) {
      previewConversations.push(processed.data);
    }
  }

  const afterHash = await sha256File(source.path, options.signal);
  if (afterHash !== beforeHash) {
    throw new CuratorError(
      "SOURCE_CHANGED_DURING_RUN",
      "输入文件在处理期间发生变化，结果已丢弃；请在文件稳定后重试。",
    );
  }

  const summary: ReportSummary = {
    totalItems,
    classified,
    duplicates,
    failed,
    currentBranchParsed,
    branchFallbacks,
    contentUnavailable,
    classificationTruncated,
    s3,
    s3Candidates,
    suggestedAccept,
    requiresReview,
  };
  const privacy: ReportPrivacy = {
    networkUsed: false,
    rawMessageBodiesIncluded: false,
    originalTitlesIncluded: false,
    sensitiveValuesIncluded: finalOutputSensitive,
  };
  const summaryEvent: ReportEvent = { type: "summary", summary, privacy };
  finalOutputSensitive ||= outputValueHasSensitiveData(summaryEvent);
  if (finalOutputSensitive) {
    privacy.sensitiveValuesIncluded = true;
    throw new CuratorError(
      "OUTPUT_SANITIZATION_FAILED",
      "最终输出扫描发现敏感值；报告已阻止写出。",
    );
  }
  privacy.sensitiveValuesIncluded = false;
  finalOutputSensitive ||=
    await emitSafely({ type: "summary", summary, privacy }, options.onEvent);

  return {
    header,
    summary,
    privacy,
    previewConversations,
    previewFailures,
  };
}
