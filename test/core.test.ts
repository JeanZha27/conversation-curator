import assert from "node:assert/strict";
import test from "node:test";
import { parseChatGptConversation } from "../src/adapters/chatgpt.ts";
import { classifyConversation } from "../src/core/heuristic-classifier.ts";
import {
  assertOutputValueSafe,
  safeConversationReference,
  sanitizeOutputValue,
} from "../src/core/output-sanitizer.ts";
import { validateClassification } from "../src/core/result-validator.ts";
import { scanSensitiveText } from "../src/core/security-scanner.ts";

function messageNode(parent: string | null, text: string, createTime: number) {
  return {
    parent,
    message: {
      create_time: createTime,
      content: { parts: [text] },
    },
  };
}

test("适配器只采样 current_node 所在分支", () => {
  const conversation = parseChatGptConversation({
    id: "conversation-1",
    title: "开发 TypeScript 工具",
    create_time: 1_700_000_000,
    update_time: 1_700_000_100,
    current_node: "answer-current",
    mapping: {
      root: { parent: null },
      question: messageNode("root", "请帮助开发 TypeScript CLI", 1),
      "answer-current": messageNode("question", "这是当前答案", 2),
      "answer-old": messageNode("question", "这是旧分支，不应被采样", 3),
    },
  });

  assert.equal(conversation.branchMode, "current");
  assert.equal(conversation.messageCount, 2);
  assert.deepEqual(conversation.sampledText, ["请帮助开发 TypeScript CLI", "这是当前答案"]);
});

test("敏感扫描只保留类型和数量，分类不能降低 S3", () => {
  const syntheticToken = `sk-${"Ab3_".repeat(6)}`; // gitleaks:allow -- constructed test-only token
  const input = `请勿保存 ${syntheticToken}，密码=synthetic-only，测试卡 4242 4242 4242 4242`;
  const scan = scanSensitiveText(input);

  assert.equal(scan.sensitivityLevel, "S3");
  assert.equal(scan.hardMatch, true);
  assert.ok((scan.matchCounts.API_KEY ?? 0) >= 1);
  assert.ok((scan.matchCounts.PASSWORD_FIELD ?? 0) >= 1);
  assert.ok((scan.matchCounts.BANK_CARD ?? 0) >= 1);
  assert.equal(scan.redactedText.includes(syntheticToken), false);
  assert.equal(JSON.stringify(scan.matchCounts).includes(syntheticToken), false);

  const conversation = parseChatGptConversation({
    id: "sensitive-1",
    title: "开发 API",
    current_node: "message",
    mapping: { message: messageNode(null, input, 1) },
  });
  const result = classifyConversation(
    {
      sourceConversationId: safeConversationReference(conversation.sourceConversationId),
      contentAvailable: conversation.contentAvailable,
      branchMode: conversation.branchMode,
    },
    scan,
    new Date("2026-01-01T00:00:00Z"),
  );
  assert.equal(result.sensitivityLevel, "S3");
  assert.equal(result.requiresReview, true);
  assert.deepEqual(validateClassification(result, { minimumSensitivity: "S3" }), []);
});

test("私钥头、合成身份证校验位和高熵候选按规则分级", () => {
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"];
  const first17 = "00000020000101001";
  const sum = weights.reduce((total, weight, index) => total + Number(first17[index]) * weight, 0);
  const syntheticIdentity = `${first17}${checks[sum % 11]}`;
  const hard = scanSensitiveText(`-----BEGIN PRIVATE KEY----- ${syntheticIdentity}`);

  assert.equal(hard.sensitivityLevel, "S3");
  assert.equal(hard.matchCounts.PRIVATE_KEY, 1);
  assert.equal(hard.matchCounts.CN_ID, 1);
  assert.equal(hard.redactedText.includes(syntheticIdentity), false);

  const candidate = "aZ9+/bY8_=cX7-dW6eV5fU4gT3hS2iR1jQ0kP";
  const uncertain = scanSensitiveText(`疑似令牌 ${candidate}`);
  assert.equal(uncertain.sensitivityLevel, "S2");
  assert.equal(uncertain.candidateMatch, true);
  assert.equal(uncertain.redactedText.includes(candidate), false);
});

test("缺失标题和空消息形成可复核边界结果", () => {
  const conversation = parseChatGptConversation({
    id: "empty-1",
    mapping: {},
  });
  const scan = scanSensitiveText(conversation.title);
  const result = classifyConversation(
    {
      sourceConversationId: safeConversationReference(conversation.sourceConversationId),
      contentAvailable: conversation.contentAvailable,
      branchMode: conversation.branchMode,
    },
    scan,
    new Date("2026-01-01T00:00:00Z"),
  );

  assert.equal(conversation.title, "未命名对话");
  assert.equal(conversation.contentAvailable, false);
  assert.equal(result.requiresReview, true);
  assert.ok(result.reasonCodes.includes("EMPTY_CONTENT"));
  assert.ok(result.reasonCodes.includes("BRANCH_FALLBACK"));
});

test("输出脱敏器覆盖嵌套对象中的每个字符串字段", () => {
  const syntheticSecret = `sk-${"FieldInjection9_".repeat(3)}`; // gitleaks:allow -- constructed test-only token
  const representative = {
    header: {
      type: "header",
      schemaVersion: "1.1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      source: {
        platform: "chatgpt",
        fileName: "conversations.json",
        sha256: "sha256:00000000:00000000:00000000:00000000:00000000:00000000:00000000:00000000",
        modifiedAt: "2026-01-01T00:00:00.000Z",
      },
    },
    conversation: {
      type: "conversation",
      data: {
        conversationRef: "conv:00000000:00000000:00000000:00000000:00000000:00000000:00000000:00000000",
        branchMode: "current",
        security: { sensitivityLevel: "S0", riskFlags: ["SAFE"], matchCounts: { SAFE: 0 } },
        classification: {
          conversationId: "conv:00000000:00000000:00000000:00000000:00000000:00000000:00000000:00000000",
          taxonomyVersion: "mvp-1",
          primaryCategoryId: "software-development",
          intent: "build_or_debug",
          deliverableType: "code",
          lifecycleStatus: "active",
          valueLevel: "V2",
          sensitivityLevel: "S0",
          suggestedTitle: "[软件开发] 整理技术问题 · 进行中",
          tags: ["software-development", "active"],
          riskFlags: ["SAFE"],
          reasonCodes: ["UNKNOWN_PROJECT"],
          classifierProvider: "heuristic-provider",
          classifierVersion: "mvp-1",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
    },
    failure: { type: "failure", data: { code: "SAFE_ERROR", message: "safe error" } },
    summary: { type: "summary" },
  };
  type PathPart = string | number;
  const paths: PathPart[][] = [];
  const collect = (value: unknown, path: PathPart[] = []): void => {
    if (typeof value === "string") {
      paths.push(path);
    } else if (Array.isArray(value)) {
      value.forEach((entry, index) => collect(entry, [...path, index]));
    } else if (typeof value === "object" && value !== null) {
      Object.entries(value).forEach(([key, entry]) => collect(entry, [...path, key]));
    }
  };
  collect(representative);
  assert.ok(paths.length > 20);

  for (const path of paths) {
    const injected = structuredClone(representative) as Record<string, unknown>;
    let cursor: any = injected;
    for (const segment of path.slice(0, -1)) cursor = cursor[segment];
    cursor[path.at(-1)!] = syntheticSecret;
    const sanitized = sanitizeOutputValue(injected);
    assert.ok(sanitized.findings > 0);
    assert.equal(JSON.stringify(sanitized.value).includes(syntheticSecret), false);
    assert.doesNotThrow(() => assertOutputValueSafe(sanitized.value));
  }
});

test("分类结果拒绝敏感标题、未知 taxonomy、未知字段和 S3 降级", () => {
  const conversation = parseChatGptConversation({
    id: "validator-1",
    title: "开发 TypeScript 工具",
    current_node: "message",
    mapping: { message: messageNode(null, "开发 TypeScript 测试", 1) },
  });
  const scan = scanSensitiveText(`${conversation.title}\n${conversation.sampledText.join("\n")}`);
  const valid = classifyConversation(
    {
      sourceConversationId: safeConversationReference(conversation.sourceConversationId),
      contentAvailable: conversation.contentAvailable,
      branchMode: conversation.branchMode,
    },
    scan,
    new Date("2026-01-01T00:00:00Z"),
  );
  assert.deepEqual(validateClassification(valid), []);

  const secretTitle = { ...valid, suggestedTitle: `[软件开发] ${`sk-${"TitleSecret9_".repeat(3)}`} · 进行中` }; // gitleaks:allow -- constructed test-only token
  assert.ok(validateClassification(secretTitle).some((error) => error.includes("敏感信息")));
  assert.ok(validateClassification({ ...valid, suggestedTitle: "过短" }).some((error) => error.includes("长度")));
  assert.ok(validateClassification({ ...valid, primaryCategoryId: "unknown-category" }).some((error) => error.includes("不存在")));
  assert.ok(validateClassification({ ...valid, unexpected: true }).some((error) => error.includes("未知字段")));
  assert.ok(validateClassification({ ...valid, tags: Array(9).fill("tag") }).some((error) => error.includes("数量")));
  assert.ok(validateClassification({ ...valid, tags: ["x".repeat(33)] }).some((error) => error.includes("长度")));
  assert.ok(
    validateClassification({ ...valid, fieldConfidence: { primaryCategoryId: 1.1 } })
      .some((error) => error.includes("fieldConfidence")),
  );
  assert.ok(
    validateClassification({ ...valid, fieldConfidence: { unknown: 0.5 } })
      .some((error) => error.includes("未知字段")),
  );
  assert.ok(validateClassification({ ...valid, riskFlags: ["UNKNOWN_RISK"] }).some((error) => error.includes("riskFlags")));
  assert.ok(validateClassification({ ...valid, reasonCodes: ["UNKNOWN_REASON"] }).some((error) => error.includes("reasonCodes")));
  assert.ok(
    validateClassification({ ...valid, sensitivityLevel: "S0" }, { minimumSensitivity: "S3" })
      .some((error) => error.includes("低于")),
  );
});
