import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
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
  sanitizeOutputString,
  sanitizeOutputValue,
} from "./output-sanitizer.ts";
import { assertValidClassification } from "./result-validator.ts";
import { scanSensitiveText } from "./security-scanner.ts";

const MAX_INPUT_BYTES = 256 * 1024 * 1024;
const MAX_CONVERSATIONS = 50_000;
const PREVIEW_CONVERSATIONS = 20;
const PREVIEW_FAILURES = 10;

type SourceInfo = {
  path: string;
  sizeBytes: number;
  modifiedAt: string;
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
    modifiedAt: sourceStat.mtime.toISOString(),
  };
}

async function sha256File(filePath: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw abortError();
  const hash = createHash("sha256");
  const stream = createReadStream(filePath, { highWaterMark: 1024 * 1024 });
  const onAbort = () => stream.destroy(abortError());
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const chunk of stream) {
      if (signal?.aborted) throw abortError();
      hash.update(chunk);
    }
    return hash.digest("hex");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    stream.destroy();
  }
}

function safeFailure(index: number, error: unknown): SafeFailure {
  const raw =
    error instanceof CuratorError
      ? { itemIndex: index, code: error.code, message: error.message }
      : error instanceof SyntaxError
        ? { itemIndex: index, code: "INVALID_ITEM_JSON", message: "对话项 JSON 无法解析。" }
        : { itemIndex: index, code: "ITEM_PROCESSING_FAILED", message: "对话项处理失败。" };
  return sanitizeOutputValue(raw).value;
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
  const safeFileName = sanitizeOutputString(basename(source.path));
  const header: ReportHeaderEvent = {
    type: "header",
    schemaVersion: "1.1",
    generatedAt,
    source: {
      platform: "chatgpt",
      fileName: safeFileName.value,
      sha256: safeSourceHash(beforeHash),
      sizeBytes: source.sizeBytes,
      modifiedAt: source.modifiedAt,
    },
  };

  let finalOutputSensitive = await emitSafely(header, options.onEvent);

  const previewConversations: ConversationReportItem[] = [];
  const previewFailures: SafeFailure[] = [];
  const seenSourceIds = new Set<string>();
  let totalItems = 0;
  let classified = 0;
  let duplicates = 0;
  let failed = 0;
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
    try {
      const parsed = JSON.parse(item.raw) as unknown;
      const conversation = parseChatGptConversation(parsed);
      const conversationRef = safeConversationReference(conversation.sourceConversationId);
      if (seenSourceIds.has(conversation.sourceConversationId)) {
        duplicates += 1;
        continue;
      }
      seenSourceIds.add(conversation.sourceConversationId);

      const scan = scanSensitiveText([conversation.title, ...conversation.sampledText].join("\n"));
      const classification = classifyConversation(
        {
          sourceConversationId: conversationRef,
          contentAvailable: conversation.contentAvailable,
          branchMode: conversation.branchMode,
        },
        scan,
        options.now ?? new Date(),
      );
      assertValidClassification(classification, { minimumSensitivity: scan.sensitivityLevel });
      const { redactedText: _discarded, ...safeSecurity } = scan;
      const sanitized = sanitizeOutputValue<ConversationReportItem>({
        conversationRef,
        messageCount: conversation.messageCount,
        branchMode: conversation.branchMode,
        security: safeSecurity,
        classification,
      });
      assertOutputValueSafe(sanitized.value);

      classified += 1;
      if (safeSecurity.sensitivityLevel === "S3") s3 += 1;
      if (safeSecurity.candidateMatch) s3Candidates += 1;
      if (classification.requiresReview) requiresReview += 1;
      else suggestedAccept += 1;
      if (previewConversations.length < PREVIEW_CONVERSATIONS) {
        previewConversations.push(sanitized.value);
      }
      finalOutputSensitive ||=
        await emitSafely({ type: "conversation", data: sanitized.value }, options.onEvent);
    } catch (error) {
      failed += 1;
      const failure = safeFailure(item.index, error);
      const sanitized = sanitizeOutputValue(failure);
      assertOutputValueSafe(sanitized.value);
      if (previewFailures.length < PREVIEW_FAILURES) previewFailures.push(sanitized.value);
      finalOutputSensitive ||=
        await emitSafely({ type: "failure", data: sanitized.value }, options.onEvent);
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
