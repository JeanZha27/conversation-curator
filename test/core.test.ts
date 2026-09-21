import assert from "node:assert/strict";
import test from "node:test";
import { parseChatGptConversation } from "../src/adapters/chatgpt.ts";
import { classifyConversation } from "../src/core/heuristic-classifier.ts";
import {
  assertOutputValueSafe,
  outputValueHasSensitiveData,
  safeConversationReference,
  sanitizeClassificationContext,
  sanitizeOutputString,
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
  assert.deepEqual(conversation.securityText, ["请帮助开发 TypeScript CLI", "这是当前答案"]);
  assert.deepEqual(conversation.sampledText, ["请帮助开发 TypeScript CLI", "这是当前答案"]);
});

test("适配器拒绝类型错误的父节点引用", () => {
  assert.throws(
    () => parseChatGptConversation({
      id: "invalid-parent",
      current_node: "message",
      mapping: {
        message: {
          parent: 42,
          message: { content: { parts: ["普通内容"] } },
        },
      },
    }),
    (error: unknown) => error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "INVALID_BRANCH",
  );
});

test("敏感扫描只保留类型和数量，分类不能降低 S3", () => {
  const syntheticToken = `sk-${"Ab3_".repeat(6)}`; // gitleaks:allow -- constructed test-only token
  const input = `请勿保存 ${syntheticToken}，密码=synthetic-only，测试卡 4242 4242 4242 4242`; // gitleaks:allow -- synthetic password only
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
      classificationTruncated: conversation.classificationTruncated,
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
  const hard = scanSensitiveText(`-----BEGIN PRIVATE KEY----- ${syntheticIdentity}`); // gitleaks:allow -- synthetic header only

  assert.equal(hard.sensitivityLevel, "S3");
  assert.equal(hard.matchCounts.PRIVATE_KEY, 1);
  assert.equal(hard.matchCounts.CN_ID, 1);
  assert.equal(hard.redactedText.includes(syntheticIdentity), false);

  const candidate = "aZ9+/bY8_=cX7-dW6eV5fU4gT3hS2iR1jQ0kP"; // gitleaks:allow -- synthetic entropy fixture
  const uncertain = scanSensitiveText(`疑似令牌 ${candidate}`);
  assert.equal(uncertain.sensitivityLevel, "S2");
  assert.equal(uncertain.candidateMatch, true);
  assert.equal(uncertain.redactedText.includes(candidate), false);
});

test("常见凭据格式、连接凭据和分片密钥进入确定性扫描", () => {
  const credentials = [
    "-----BEGIN ENCRYPTED PRIVATE KEY-----", // gitleaks:allow -- synthetic header only
    "-----BEGIN PGP PRIVATE KEY BLOCK-----", // gitleaks:allow -- synthetic header only
    `github_pat_${"Synthetic9_".repeat(3)}`,
    `glpat-${"Synthetic8_".repeat(2)}`,
    `npm_${"Synthetic7".repeat(3)}`,
    `xoxb-${"1234567890-".repeat(2)}`,
    "Authorization: Basic U3ludGhldGljOk9ubHk=", // gitleaks:allow -- synthetic credential only
    "Cookie: session=synthetic-session-value", // gitleaks:allow -- synthetic credential only
    "postgres://synthetic-user:synthetic-password@example.invalid/db", // gitleaks:allow -- synthetic credential only
    'DB_PASSWORD="synthetic phrase value"', // gitleaks:allow -- synthetic credential only
    "AWS_SECRET_ACCESS_KEY=synthetic-access-secret", // gitleaks:allow -- synthetic credential only
  ];
  for (const credential of credentials) {
    const scan = scanSensitiveText(credential);
    assert.equal(scan.sensitivityLevel, "S3");
    assert.equal(scan.redactedText.includes(credential), false);
  }

  const split = parseChatGptConversation({
    id: "split-secret",
    current_node: "message",
    mapping: {
      message: {
        parent: null,
        message: { content: { parts: ["sk-", "SyntheticPart9_", "SyntheticPart8_"] } },
      },
    },
  });
  const scan = scanSensitiveText(split.securityText.join("\n"));
  assert.equal(scan.sensitivityLevel, "S3");
  assert.equal(scan.matchCounts.API_KEY, 1);
});

test("凭据前置筛选覆盖每个已声明的格式分支", () => {
  const apiKeys = [
    `sk_live_${"A".repeat(20)}`,
    `rk_live_${"B".repeat(20)}`,
    `sk-${"C".repeat(20)}`,
    `AKIA${"D".repeat(16)}`,
    `ASIA${"E".repeat(16)}`,
    `ghp_${"F".repeat(20)}`,
    `github_pat_${"G".repeat(20)}`,
    `glpat-${"H".repeat(20)}`,
    `npm_${"I".repeat(20)}`,
    `hf_${"J".repeat(20)}`,
    `AIza${"K".repeat(30)}`,
    `xoxb-${"L".repeat(12)}`,
  ];
  const fields = [
    "PASSWORD", "PASSWD", "PWD", "APIKEY", "API_KEY", "API-KEY",
    "ACCESSTOKEN", "ACCESS_TOKEN", "ACCESS-TOKEN",
    "CLIENTSECRET", "CLIENT_SECRET", "CLIENT-SECRET",
    "SECRETKEY", "SECRET_KEY", "SECRET-ACCESS-KEY", "DB_PASSWORD",
  ];
  for (const value of [...apiKeys, ...fields.map((field) => `${field}=syntheticvalue`)]) {
    const scan = scanSensitiveText(value);
    assert.equal(scan.sensitivityLevel, "S3", `missed synthetic format: ${value.slice(0, 8)}`);
    assert.equal(scan.hardMatch, true);
    assert.equal(scan.redactedText.includes(value), false);
    assert.equal(sanitizeClassificationContext(value).includes(value), false);
    assert.equal(outputValueHasSensitiveData(value), true);
  }
});

test("短凭据值也必须在分类前和输出边界脱敏", () => {
  for (const [field, value] of [
    ["password", "x"],
    ["API_KEY", "xy"],
    ["密码", "短"],
    ["CLIENTSECRET", "'z'"],
  ] as const) {
    const input = `${field}=${value}`;
    const scan = scanSensitiveText(input);
    assert.equal(scan.sensitivityLevel, "S3", `missed short synthetic credential field: ${field}`);
    assert.equal(scan.hardMatch, true);
    assert.equal(scan.redactedText.includes(value), false);
    assert.equal(sanitizeClassificationContext(input).includes(value), false);
    assert.equal(outputValueHasSensitiveData(input), true);
  }
});

test("隐藏和非对话角色仅参与安全扫描，不进入分类上下文", () => {
  const secret = `sk-${"HiddenRole9_".repeat(3)}`; // gitleaks:allow -- constructed test-only token
  const conversation = parseChatGptConversation({
    id: "role-filter",
    current_node: "assistant",
    mapping: {
      hidden: {
        parent: null,
        message: {
          author: { role: "system" },
          content: { parts: [`typescript ${secret}`] },
        },
      },
      assistant: {
        parent: "hidden",
        message: {
          author: { role: "assistant" },
          metadata: { is_visually_hidden_from_conversation: true },
          content: { parts: ["python hidden"] },
        },
      },
    },
  });
  assert.equal(conversation.contentAvailable, false);
  assert.deepEqual(conversation.sampledText, []);
  const scan = scanSensitiveText(conversation.securityText.join("\n"));
  assert.equal(scan.sensitivityLevel, "S3");
});

test("英文分类关键词使用词边界", () => {
  const base = {
    sourceConversationId: safeConversationReference("keyword-boundary"),
    contentAvailable: true,
    classificationTruncated: false,
    branchMode: "current" as const,
  };
  const falsePositive = classifyConversation(base, scanSensitiveText("anode catalog"));
  const exact = classifyConversation(base, scanSensitiveText("node api"));
  assert.equal(falsePositive.primaryCategoryId, "other");
  assert.equal(exact.primaryCategoryId, "software-development");
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
      classificationTruncated: conversation.classificationTruncated,
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
      schemaVersion: "1.3",
      generatedAt: "2026-01-01T00:00:00.000Z",
      source: {
        platform: "chatgpt",
        fileName: "conversations.json",
        sha256: "sha256:00000000:00000000:00000000:00000000:00000000:00000000:00000000:00000000",
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

test("输出脱敏器覆盖邮箱、手机号和本地绝对路径", () => {
  const values = [
    "alice@example.com-13800138000.json",
    "+44 7700 900123",
    "0044 7700 900123",
    "07700 900123",
    "(415) 555-2671",
    "415-555-2671",
    "415 555 2671",
    "/Users/example/private/conversations.json",
    "/var/f/a",
    "/opt/acme/x",
    "file:///var/a",
    "请看file:///var/private/a",
    "C:\\Users\\example\\conversations.json",
    "C:/Users/example/private report.json",
    "路径是C:\\Users\\example\\private.txt",
    "filepathC:\\Users\\example\\private.txt",
    "路径:/var/private report.json",
    "文件在/var/a",
    "文件在/Users/example/a",
    "文件在/Volumes/External/a",
  ];

  for (const value of values) {
    const sanitized = sanitizeOutputString(value);
    assert.ok(sanitized.findings > 0);
    assert.equal(sanitized.value.includes(value), false);
    assert.equal(outputValueHasSensitiveData(value), true);
    assert.doesNotThrow(() => assertOutputValueSafe(sanitized.value));
  }

  for (const url of [
    "https://example.com/path",
    "http://localhost:3000/report",
    "ftp://files.example.com/pub/a.txt",
    "wss://socket.example.com/a",
    "//cdn.example.com/a",
  ]) {
    assert.equal(sanitizeOutputString(url).findings, 0);
    assert.equal(outputValueHasSensitiveData(url), false);
  }

  for (const nonPhone of [
    "2026-09-16",
    "09-16-2026",
    "09:30",
    "共 12345678 条",
    "计数 0000 1234",
    "计数 012345678",
    "版本 1234-5678",
  ]) {
    assert.equal(sanitizeOutputString(nonPhone).findings, 0);
    assert.equal(outputValueHasSensitiveData(nonPhone), false);
  }

  for (const slashPhrase of [
    "1/2",
    "2026/09/17",
    "和/或",
    "input/output",
    "input/private/output",
    "docs/var/config",
    "project/home/page",
  ]) {
    assert.equal(sanitizeOutputString(slashPhrase).findings, 0);
    assert.equal(outputValueHasSensitiveData(slashPhrase), false);
  }

  const spacedPath = "/var/Project Zephyr/private report.json";
  const sanitizedPath = sanitizeOutputString(spacedPath);
  assert.ok(sanitizedPath.findings > 0);
  for (const sentinel of ["Project", "Zephyr", "private", "report.json"]) {
    assert.equal(sanitizedPath.value.includes(sentinel), false);
  }
  assert.equal(outputValueHasSensitiveData(sanitizedPath.value), false);
});

test("输出脱敏器覆盖点分隔号码、紧凑国际号码和中文紧邻绝对路径", () => {
  for (const value of [
    "415.555.2671",
    "00447700900123",
    "+44.20.7183.8750",
    "请看/Users/example/private.txt",
    "参见/var/example/config.json",
    "位于/Volumes/Example/data.json",
    "配置/我的/私密/目录 请查看",
  ]) {
    assert.ok(sanitizeOutputString(value).findings > 0);
    assert.equal(outputValueHasSensitiveData(value), true);
  }
  for (const value of ["和/或", "input/var/config", "192.168.1.1", "1.2.3"]) {
    assert.equal(sanitizeOutputString(value).findings, 0);
  }
});

test("分类上下文复用完整输出隐私策略", () => {
  const sensitiveValues = [
    "alice@example.com",
    "+44 7700 900123",
    "文件在/var/a",
    "C:\\Users\\example\\private.txt",
    "路径是C:\\Users\\example\\private.txt",
    "filepathC:\\Users\\example\\private.txt",
    "file:///var/private.txt",
    "请看file:///var/private.txt",
    "文件在/Volumes/External/a",
  ];
  const sanitized = sanitizeClassificationContext(sensitiveValues.join("\n"));

  for (const value of sensitiveValues) assert.equal(sanitized.includes(value), false);
  assert.equal(outputValueHasSensitiveData(sanitized), false);
});

test("分类上下文中的脱敏占位符不参与关键词匹配", () => {
  const sanitized = sanitizeClassificationContext("alice@example.com");
  const result = classifyConversation(
    {
      sourceConversationId: safeConversationReference("redaction-marker"),
      contentAvailable: true,
      classificationTruncated: false,
      branchMode: "current",
    },
    {
      redactedText: sanitized,
      sensitivityLevel: "S0",
      riskFlags: [],
      matchCounts: {},
      hardMatch: false,
      candidateMatch: false,
    },
    new Date("2026-01-01T00:00:00Z"),
  );

  assert.equal(sanitized.includes("EMAIL"), false);
  assert.equal(result.primaryCategoryId, "other");
});

test("分类字段复用统一输出隐私规则", () => {
  const conversation = parseChatGptConversation({
    id: "privacy-validator-1",
    title: "开发 TypeScript 工具",
    current_node: "message",
    mapping: { message: messageNode(null, "开发 TypeScript 测试", 1) },
  });
  const scan = scanSensitiveText(`${conversation.title}\n${conversation.sampledText.join("\n")}`);
  const valid = classifyConversation(
    {
      sourceConversationId: safeConversationReference(conversation.sourceConversationId),
      contentAvailable: conversation.contentAvailable,
      classificationTruncated: conversation.classificationTruncated,
      branchMode: conversation.branchMode,
    },
    scan,
    new Date("2026-01-01T00:00:00Z"),
  );

  assert.ok(
    validateClassification({
      ...valid,
      suggestedTitle: "[客户支持] 联系+44 7700 900123 · 进行中",
    }).some((error) => error.includes("suggestedTitle 含敏感信息")),
  );
  for (const tag of [
    "alice@example.com",
    "/var/f/a",
    "/opt/acme/x",
    "文件在/var/a",
    "文件在/Users/example/a",
    "文件在/Volumes/External/a",
    "路径是C:\\Users\\example\\private.txt",
    "filepathC:\\Users\\example\\private.txt",
    "file:///var/a",
    "0044 7700 900123",
    "07700 900123",
    "(415) 555-2671",
    "415-555-2671",
    "415 555 2671",
  ]) {
    assert.ok(
      validateClassification({ ...valid, tags: [tag] })
        .some((error) => error.includes("tags[0] 含敏感信息")),
    );
  }
  for (const tag of ["input/private/output", "docs/var/config", "project/home/page"]) {
    assert.ok(
      validateClassification({ ...valid, tags: [tag] })
        .some((error) => error.includes("tags 与 taxonomy")),
    );
  }
});

test("错误字段中的国际号码和通用绝对路径会被输出脱敏", () => {
  const unsafeFailure = {
    type: "failure",
    data: {
      code: "SYNTHETIC_FAILURE",
      message: "联系 +44 7700 900123，检查 /var/f/a 与 /opt/acme/x",
    },
  };
  const sanitized = sanitizeOutputValue(unsafeFailure);

  assert.ok(sanitized.findings >= 3);
  assert.equal(JSON.stringify(sanitized.value).includes("+44 7700 900123"), false);
  assert.equal(JSON.stringify(sanitized.value).includes("/var/f/a"), false);
  assert.equal(JSON.stringify(sanitized.value).includes("/opt/acme/x"), false);
  assert.doesNotThrow(() => assertOutputValueSafe(sanitized.value));
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
      classificationTruncated: conversation.classificationTruncated,
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
  assert.ok(validateClassification({ ...valid, riskFlags: ["SENSITIVE_PATTERN", "SENSITIVE_PATTERN"] }).some((error) => error.includes("riskFlags")));
  assert.ok(validateClassification({ ...valid, reasonCodes: ["UNKNOWN_REASON"] }).some((error) => error.includes("reasonCodes")));
  assert.ok(
    validateClassification({ ...valid, riskFlags: ["SENSITIVE_PATTERN"] })
      .some((error) => error.includes("riskFlags")),
  );
  assert.ok(
    validateClassification(valid, { requiredReasonCodes: ["EMPTY_CONTENT"] })
      .some((error) => error.includes("强制复核原因")),
  );
  assert.ok(
    validateClassification({
      ...valid,
      reasonCodes: valid.reasonCodes.filter((code) => code !== "LOW_CONFIDENCE"),
    }).some((error) => error.includes("fieldConfidence")),
  );
  assert.ok(
    validateClassification({
      ...valid,
      reasonCodes: valid.reasonCodes.filter((code) => code !== "UNKNOWN_PROJECT"),
    }).some((error) => error.includes("UNKNOWN_PROJECT")),
  );
  assert.ok(
    validateClassification({ ...valid, sensitivityLevel: "S0" }, { minimumSensitivity: "S3" })
      .some((error) => error.includes("低于")),
  );
  assert.ok(
    validateClassification(valid, {
      expectedConversationId: safeConversationReference("another-conversation"),
    }).some((error) => error.includes("当前分类请求不一致")),
  );
  assert.ok(
    validateClassification({
      ...valid,
      fieldConfidence: { primaryCategoryId: 0.9 },
    }).some((error) => error.includes("缺少字段")),
  );
  assert.ok(
    validateClassification(
      { ...valid, sensitivityLevel: "S3", requiresReview: false },
      { minimumSensitivity: "S3", requiresReview: true },
    ).some((error) => error.includes("强制复核")),
  );
  assert.ok(
    validateClassification(valid, { expectedRiskFlags: ["S3_CANDIDATE"] })
      .some((error) => error.includes("确定性扫描结果不一致")),
  );
  assert.ok(
    validateClassification({ ...valid, suggestedTitle: "[软件开发] Project Aurora · 进行中" })
      .some((error) => error.includes("taxonomy")),
  );
  assert.doesNotThrow(() => validateClassification({
    ...valid,
    riskFlags: 42,
    reasonCodes: "LOW_CONFIDENCE",
  }));
  assert.ok(validateClassification({
    ...valid,
    riskFlags: 42,
    reasonCodes: "LOW_CONFIDENCE",
  }).some((error) => error.includes("riskFlags")));
  const privateField = "Project Aurora";
  const unknownErrors = validateClassification({ ...valid, [privateField]: true });
  assert.equal(unknownErrors.some((error) => error.includes(privateField)), false);
  assert.ok(
    validateClassification({ ...valid, createdAt: "January 1, 2026" })
      .some((error) => error.includes("createdAt")),
  );
});
