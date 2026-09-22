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
import { createInputSnapshot, type InputSnapshot } from "./input-snapshot.ts";
import { streamJsonObjectArray } from "./json-array-stream.ts";
import {
  assertOutputValueSafe,
  safeConversationReference,
  safeSourceHash,
  sanitizeClassificationContext,
  sanitizeOutputValue,
} from "./output-sanitizer.ts";
import { assertValidClassification } from "./result-validator.ts";
import { scanSensitiveSegments } from "./security-scanner.ts";

const MAX_CONVERSATIONS = 50_000;
const PREVIEW_CONVERSATIONS = 20;
const PREVIEW_FAILURES = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inputNotChatGptExport(): CuratorError {
  return new CuratorError(
    "INPUT_NOT_CHATGPT_EXPORT",
    "输入文件不是受支持的 ChatGPT conversations.json 导出。",
  );
}

function looksLikeChatGptConversation(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.mapping)) return false;
  const id = typeof value.id === "string" ? value.id : value.conversation_id;
  return typeof id === "string" && id.trim().length > 0;
}

async function validateChatGptExportShape(
  filePath: string,
  signal?: AbortSignal,
): Promise<void> {
  const iterator = streamJsonObjectArray(filePath, signal)[Symbol.asyncIterator]();
  try {
    const first = await iterator.next();
    if (first.done) return;
    if (!looksLikeChatGptConversation(JSON.parse(first.value.raw) as unknown)) {
      throw inputNotChatGptExport();
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    if (
      error instanceof CuratorError &&
      (error.code === "INVALID_UTF8" || error.code === "CONVERSATION_TOO_LARGE")
    ) {
      throw error;
    }
    throw inputNotChatGptExport();
  } finally {
    await iterator.return?.(undefined);
  }
}

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

function safeFailure(index: number, error: unknown): SafeFailure {
  const safeErrors: Record<string, string> = {
    INVALID_CONVERSATION: "对话项不是受支持的对象。",
    MISSING_CONVERSATION_ID: "对话项缺少稳定 ID。",
    MISSING_MAPPING: "对话项缺少 mapping 对象。",
    MAPPING_NODE_LIMIT_EXCEEDED: "对话 mapping 节点数量超过安全上限。",
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
): Promise<void> {
  assertOutputValueSafe(event);
  await onEvent?.(event);
}

async function runSnapshot(
  options: RunOptions,
  source: InputSnapshot,
): Promise<CuratorRunResult> {
  await validateChatGptExportShape(source.path, options.signal);
  const generatedAt = (options.now ?? new Date()).toISOString();
  const header: ReportHeaderEvent = {
    type: "header",
    schemaVersion: "1.4",
    generatedAt,
    source: {
      platform: "chatgpt",
      // A source filename is user-controlled metadata and may itself contain
      // personal data. Keep the report useful without persisting that value.
      fileName: "conversations.json",
      sha256: safeSourceHash(source.sha256),
      sizeBytes: source.sizeBytes,
    },
  };

  await emitSafely(header, options.onEvent);

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
      await emitSafely({ type: "failure", data: sanitized.value }, options.onEvent);
      failed += 1;
      if (previewFailures.length < PREVIEW_FAILURES) previewFailures.push(sanitized.value);
      continue;
    }

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
    // This is an invariant of every successful report. Unsafe output aborts
    // the run before the summary can be emitted or a report can be committed.
    sensitiveValuesIncluded: false,
    crossRunLinkable: true,
  };
  await emitSafely({ type: "summary", summary, privacy }, options.onEvent);

  return {
    header,
    summary,
    privacy,
    previewConversations,
    previewFailures,
  };
}

export async function runCurator(options: RunOptions): Promise<CuratorRunResult> {
  const snapshot = await createInputSnapshot(options.inputPath, options.signal);
  try {
    return await runSnapshot(options, snapshot);
  } finally {
    await snapshot.cleanup();
  }
}
