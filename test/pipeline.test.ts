import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, link, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { main } from "../src/cli.ts";
import { CuratorError } from "../src/core/errors.ts";
import { createJsonEventSink } from "../src/core/json-event-sink.ts";
import { runCurator } from "../src/core/pipeline.ts";
import type { ReportEvent } from "../src/types.ts";

const execFileAsync = promisify(execFile);

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function node(parent: string | null, text: string, createTime: number) {
  return {
    parent,
    message: { create_time: createTime, content: { parts: [text] } },
  };
}

function syntheticExport(secret: string) {
  return [
    {
      id: "normal-1",
      title: "完成 TypeScript API 测试",
      create_time: 1_700_000_000,
      update_time: 1_700_000_100,
      current_node: "answer",
      mapping: {
        root: { parent: null },
        question: node("root", "请开发 TypeScript API 测试", 1),
        answer: node("question", "测试已完成", 2),
      },
    },
    {
      id: secret,
      title: `不要记录原始标题 ${secret}`,
      current_node: "only",
      mapping: { only: node(null, `原始正文 PRIVATE-SYNTHETIC-BODY，token=${secret}`, 1) },
    },
    {
      id: "normal-1",
      title: "重复项",
      mapping: {},
    },
  ];
}

async function collectRun(inputPath: string) {
  const events: ReportEvent[] = [];
  const result = await runCurator({
    inputPath,
    now: new Date("2026-01-01T00:00:00Z"),
    onEvent: async (event) => {
      events.push(event);
    },
  });
  return { result, events };
}

async function copyCliRuntimeFixture(sourceProject: URL, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  await cp(new URL("src/", sourceProject), join(destination, "src"), { recursive: true });
  await cp(new URL("package.json", sourceProject), join(destination, "package.json"));
}

test("输入路径、文件类型、空文件和 256 MiB 上限在读取前拒绝", async () => {
  const directory = await mkdtemp(join(tmpdir(), "curator-input-boundaries-"));
  try {
    const wrongType = join(directory, "conversations.txt");
    const empty = join(directory, "empty.json");
    const notFile = join(directory, "directory.json");
    const tooLarge = join(directory, "large.json");
    await writeFile(wrongType, "[]");
    await writeFile(empty, "");
    await mkdir(notFile);
    await writeFile(tooLarge, "[]");
    await truncate(tooLarge, 256 * 1024 * 1024 + 1);

    for (const [path, code] of [
      [wrongType, "INVALID_FILE_TYPE"],
      [empty, "INPUT_EMPTY"],
      [notFile, "INPUT_NOT_FILE"],
      [tooLarge, "INPUT_TOO_LARGE"],
    ] as const) {
      await assert.rejects(
        () => runCurator({ inputPath: path }),
        (error: unknown) => error instanceof CuratorError && error.code === code,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("输入到流式安全报告的完整链路保持源文件不变", async () => {
  const directory = await mkdtemp(join(tmpdir(), "curator-pipeline-"));
  try {
    const secret = `sk-${"Synthetic9_".repeat(3)}`; // gitleaks:allow -- constructed test-only token
    const fileSecret = `sk-${"FileName8_".repeat(3)}`; // gitleaks:allow -- constructed test-only token
    const inputPath = join(directory, `conversations-${fileSecret}.json`);
    const outputPath = join(directory, "report.json");
    await writeFile(inputPath, JSON.stringify(syntheticExport(secret)));
    const before = await readFile(inputPath);

    const sink = await createJsonEventSink({ outputPath, sourcePath: inputPath, force: false });
    const result = await runCurator({
      inputPath,
      now: new Date("2026-01-01T00:00:00Z"),
      onEvent: sink.write,
    });
    await sink.commit();

    assert.equal(result.summary.totalItems, 3);
    assert.equal(result.summary.classified, 2);
    assert.equal(result.summary.duplicates, 1);
    assert.equal(result.summary.failed, 0);
    assert.equal(result.summary.s3, 1);
    assert.equal(result.privacy.sensitiveValuesIncluded, false);

    const written = await readFile(outputPath, "utf8");
    assert.equal(written.includes(secret), false);
    assert.equal(written.includes(fileSecret), false);
    assert.equal(written.includes("PRIVATE-SYNTHETIC-BODY"), false);
    assert.equal(written.includes("不要记录原始标题"), false);
    const events = JSON.parse(written) as ReportEvent[];
    assert.equal(events[0]!.type, "header");
    assert.equal(events.at(-1)?.type, "summary");
    assert.equal(events.filter((event) => event.type === "conversation").length, 2);
    assert.equal(sha256(await readFile(inputPath)), sha256(before));

    await assert.rejects(
      () => createJsonEventSink({ outputPath, sourcePath: inputPath, force: false }),
      (error: unknown) => error instanceof CuratorError && error.code === "OUTPUT_EXISTS",
    );
    await assert.rejects(
      () => createJsonEventSink({ outputPath: inputPath, sourcePath: inputPath, force: true }),
      (error: unknown) => error instanceof CuratorError && error.code === "OUTPUT_OVERWRITES_SOURCE",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("重复 ID 项仍扫描敏感内容且整次运行标记为不完整", async () => {
  const directory = await mkdtemp(join(tmpdir(), "curator-duplicate-security-"));
  try {
    const inputPath = join(directory, "conversations.json");
    const syntheticCredential = ["API", "KEY=x"].join("");
    const item = (text: string) => ({
      id: "same-synthetic-id",
      current_node: "only",
      mapping: { only: node(null, text, 1) },
    });
    await writeFile(inputPath, JSON.stringify([item("ordinary text"), item(syntheticCredential)]));

    const result = await runCurator({ inputPath });
    assert.equal(result.summary.totalItems, 2);
    assert.equal(result.summary.classified, 1);
    assert.equal(result.summary.duplicates, 1);
    assert.equal(result.summary.s3, 1);
    assert.equal(result.summary.failed, 0);

    await assert.rejects(
      () => execFileAsync(process.execPath, ["src/cli.ts", "--input", inputPath, "--summary-only"], {
        cwd: new URL("..", import.meta.url),
      }),
      (error: unknown) => {
        const value = error as { code?: number; stdout?: string };
        return value.code === 2 &&
          Boolean(value.stdout?.includes("S3：1")) &&
          !value.stdout?.includes(syntheticCredential);
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("PII 文件名不会进入报告或隐私断言", async () => {
  const directory = await mkdtemp(join(tmpdir(), "curator-pii-filename-"));
  try {
    const pii = "alice@example.com-13800138000";
    const inputPath = join(directory, `${pii}.json`);
    const outputPath = join(directory, "report.json");
    await writeFile(inputPath, JSON.stringify(syntheticExport("safe-synthetic-id")));

    const sink = await createJsonEventSink({ outputPath, sourcePath: inputPath, force: false });
    const result = await runCurator({ inputPath, onEvent: sink.write });
    await sink.commit();

    const written = await readFile(outputPath, "utf8");
    assert.equal(written.includes("alice@example.com"), false);
    assert.equal(written.includes("13800138000"), false);
    assert.equal(result.header.source.fileName, "conversations.json");
    assert.equal(result.privacy.sensitiveValuesIncluded, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("确定性扫描覆盖当前分支全部消息但分类只使用首尾采样", async () => {
  const directory = await mkdtemp(join(tmpdir(), "curator-full-branch-scan-"));
  try {
    const secret = `sk-${"MiddleOnly9_".repeat(3)}`; // gitleaks:allow -- constructed test-only token
    const mapping: Record<string, unknown> = {};
    let parent: string | null = null;
    for (let index = 0; index < 7; index += 1) {
      const id = `message-${index + 1}`;
      const text = index === 3 ? `typescript 中间消息 ${secret}` : `中性消息 ${index + 1}`;
      mapping[id] = node(parent, text, index + 1);
      parent = id;
    }
    const inputPath = join(directory, "conversations.json");
    await writeFile(inputPath, JSON.stringify([{
      id: "middle-sensitive",
      title: "普通主题",
      current_node: parent,
      mapping,
    }]));

    const { result, events } = await collectRun(inputPath);
    const event = events.find((entry) => entry.type === "conversation");
    assert.equal(event?.type, "conversation");
    if (event?.type !== "conversation") return;
    assert.equal(event.data.security.sensitivityLevel, "S3");
    assert.equal(event.data.security.matchCounts.API_KEY, 1);
    assert.equal(event.data.classification.requiresReview, true);
    assert.equal(event.data.classification.primaryCategoryId, "other");
    assert.equal(result.summary.s3, 1);
    assert.equal(result.summary.suggestedAccept, 0);
    assert.equal(JSON.stringify(events).includes(secret), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("超长单条消息的分类上下文有界且完整安全扫描不截断", async () => {
  const directory = await mkdtemp(join(tmpdir(), "curator-long-message-"));
  try {
    const secret = `sk-${"LongMiddle9_".repeat(3)}`; // gitleaks:allow -- constructed test-only token
    const text = `起始${"x".repeat(20_000)} ${secret} ${"y".repeat(20_000)}结束`;
    const inputPath = join(directory, "conversations.json");
    await writeFile(inputPath, JSON.stringify([{
      id: "long-message",
      title: "普通主题",
      current_node: "message",
      mapping: { message: node(null, text, 1) },
    }]));

    const { result, events } = await collectRun(inputPath);
    const event = events.find((entry) => entry.type === "conversation");
    assert.equal(event?.type, "conversation");
    if (event?.type !== "conversation") return;
    assert.equal(event.data.classificationTruncated, true);
    assert.equal(event.data.security.sensitivityLevel, "S3");
    assert.equal(event.data.classification.requiresReview, true);
    assert.ok(event.data.classification.reasonCodes.includes("CONTENT_TRUNCATED"));
    assert.equal(result.summary.classificationTruncated, 1);
    assert.equal(JSON.stringify(events).includes(secret), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("附件只扫描白名单元数据并忽略附件正文", async () => {
  const directory = await mkdtemp(join(tmpdir(), "curator-attachment-metadata-"));
  try {
    const metadataSecret = `sk-${"Attachment9_".repeat(3)}`; // gitleaks:allow -- constructed test-only token
    const ignoredBodySecret = `sk-${"BinaryBody8_".repeat(3)}`; // gitleaks:allow -- constructed test-only token
    const inputPath = join(directory, "conversations.json");
    await writeFile(inputPath, JSON.stringify([{
      id: "attachment-sensitive",
      title: "附件检查",
      current_node: "attachment",
      mapping: {
        attachment: {
          parent: null,
          message: {
            create_time: 1,
            content: {
              parts: [{
                filename: `brief-${metadataSecret}.pdf`,
                content_type: "application/pdf",
                data: { name: ignoredBodySecret, contentType: ignoredBodySecret },
                payload: { filename: ignoredBodySecret },
                body: { file_name: ignoredBodySecret },
              }],
            },
          },
        },
      },
    }]));

    const { events } = await collectRun(inputPath);
    const event = events.find((entry) => entry.type === "conversation");
    assert.equal(event?.type, "conversation");
    if (event?.type !== "conversation") return;
    assert.equal(event.data.security.sensitivityLevel, "S3");
    assert.equal(event.data.security.matchCounts.API_KEY, 1);
    assert.equal(event.data.classification.requiresReview, true);
    assert.equal(JSON.stringify(events).includes(metadataSecret), false);
    assert.equal(JSON.stringify(events).includes(ignoredBodySecret), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("分类上下文使用敏感扫描后的首尾文本", async () => {
  const directory = await mkdtemp(join(tmpdir(), "curator-redacted-classification-"));
  try {
    const inputPath = join(directory, "conversations.json");
    await writeFile(inputPath, JSON.stringify([{
      id: "redacted-classification",
      title: "普通主题",
      current_node: "message",
      mapping: {
        message: node(null, "password=typescript", 1), // gitleaks:allow -- synthetic password only
      },
    }]));

    const { events } = await collectRun(inputPath);
    const event = events.find((entry) => entry.type === "conversation");
    assert.equal(event?.type, "conversation");
    if (event?.type !== "conversation") return;
    assert.equal(event.data.security.sensitivityLevel, "S3");
    assert.equal(event.data.classification.primaryCategoryId, "other");
    assert.equal(event.data.classification.requiresReview, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("预先取消时停止处理且不写任何结果", async () => {
  const directory = await mkdtemp(join(tmpdir(), "curator-abort-"));
  try {
    const inputPath = join(directory, "conversations.json");
    await writeFile(inputPath, JSON.stringify(syntheticExport("sk-SyntheticCancel123456"))); // gitleaks:allow -- literal test-only token
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () => runCurator({ inputPath, signal: controller.signal }),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("提交前收到 SIGINT 时返回 130 且不提交报告", async () => {
  const directory = await mkdtemp(join(tmpdir(), "curator-precommit-abort-"));
  try {
    const inputPath = join(directory, "conversations.json");
    const outputPath = join(directory, "report.json");
    await writeFile(inputPath, JSON.stringify([{
      id: "precommit-abort",
      title: "普通主题",
      current_node: "message",
      mapping: { message: node(null, "普通内容", 1) },
    }]));

    const exitCode = await main(
      ["--input", inputPath, "--write", "--output", outputPath],
      { beforeCommit: () => { process.emit("SIGINT"); } },
    );

    assert.equal(exitCode, 130);
    await assert.rejects(() => readFile(outputPath));
    const remaining = await import("node:fs/promises").then(({ readdir }) => readdir(directory));
    assert.deepEqual(remaining, ["conversations.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("提交过程中取消会保留目标缺失并清理临时文件", async () => {
  const directory = await mkdtemp(join(tmpdir(), "curator-commit-abort-"));
  try {
    const inputPath = join(directory, "conversations.json");
    const outputPath = join(directory, "report.json");
    await writeFile(inputPath, "[]");
    const sink = await createJsonEventSink({ outputPath, sourcePath: inputPath, force: false });
    const controller = new AbortController();

    const committing = sink.commit(controller.signal);
    queueMicrotask(() => controller.abort());
    await assert.rejects(
      committing,
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    await sink.abort();

    await assert.rejects(() => readFile(outputPath));
    const remaining = await import("node:fs/promises").then(({ readdir }) => readdir(directory));
    assert.deepEqual(remaining, ["conversations.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("取消后的清理失败返回稳定错误且不误报无残留", async () => {
  const directory = await mkdtemp(join(tmpdir(), "curator-cleanup-failure-"));
  const originalStderrWrite = process.stderr.write;
  let stderr = "";
  try {
    const inputPath = join(directory, "conversations.json");
    const outputPath = join(directory, "report.json");
    await writeFile(inputPath, JSON.stringify([{
      id: "cleanup-failure",
      title: "普通主题",
      current_node: "message",
      mapping: { message: node(null, "普通内容", 1) },
    }]));
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    const exitCode = await main(
      ["--input", inputPath, "--write", "--output", outputPath],
      {
        beforeCommit: () => { process.emit("SIGINT"); },
        createSink: (options) => createJsonEventSink(options, {
          removeTemporary: async () => {
            throw new Error(`synthetic cleanup failure: ${outputPath}`);
          },
        }),
      },
    );

    assert.equal(exitCode, 1);
    assert.match(stderr, /OUTPUT_CLEANUP_FAILED/u);
    assert.match(stderr, /手动删除隐藏的 \.tmp 报告文件/u);
    assert.equal(stderr.includes("未留下未完成的报告"), false);
    assert.equal(stderr.includes("synthetic cleanup failure"), false);
    assert.equal(stderr.includes(outputPath), false);
    await assert.rejects(() => readFile(outputPath));
    const remaining = await import("node:fs/promises").then(({ readdir }) => readdir(directory));
    assert.equal(remaining.filter((name) => name.endsWith(".tmp")).length, 1);
  } finally {
    process.stderr.write = originalStderrWrite;
    await rm(directory, { recursive: true, force: true });
  }
});

test("单项 JSON 损坏时流式记录安全失败并继续后续项", async () => {
  const directory = await mkdtemp(join(tmpdir(), "curator-partial-"));
  try {
    const inputPath = join(directory, "conversations.json");
    const validOne = JSON.stringify(syntheticExport("sk-PartialSynthetic123456")[0]); // gitleaks:allow -- literal test-only token
    const validTwo = JSON.stringify({ id: "after-failure", title: "学习研究", mapping: {} });
    await writeFile(inputPath, `[${validOne},{"id":"broken",},${validTwo}]`);

    const { result, events } = await collectRun(inputPath);
    assert.equal(result.summary.totalItems, 3);
    assert.equal(result.summary.classified, 2);
    assert.equal(result.summary.failed, 1);
    const failure = events.find((event) => event.type === "failure");
    assert.equal(failure?.type === "failure" ? failure.data.code : null, "INVALID_ITEM_JSON");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("报告写入回调失败会中止整次运行而不会伪装成单项失败", async () => {
  const directory = await mkdtemp(join(tmpdir(), "curator-event-failure-"));
  try {
    const inputPath = join(directory, "conversations.json");
    await writeFile(inputPath, JSON.stringify([{
      id: "event-failure",
      title: "普通主题",
      current_node: "message",
      mapping: { message: node(null, "普通内容", 1) },
    }]));
    const emitted: string[] = [];
    await assert.rejects(
      () => runCurator({
        inputPath,
        onEvent: async (event) => {
          if (event.type === "conversation") throw new Error("synthetic sink failure");
          emitted.push(event.type);
        },
      }),
      /synthetic sink failure/u,
    );
    assert.deepEqual(emitted, ["header"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("处理期间源文件变化会使整次结果失效", async () => {
  const directory = await mkdtemp(join(tmpdir(), "curator-source-change-"));
  try {
    const inputPath = join(directory, "conversations.json");
    const original = JSON.stringify([{
      id: "source-change",
      title: "普通主题",
      current_node: "message",
      mapping: { message: node(null, "普通内容", 1) },
    }]);
    await writeFile(inputPath, original);
    let changed = false;
    await assert.rejects(
      () => runCurator({
        inputPath,
        onEvent: async (event) => {
          if (!changed && event.type === "conversation") {
            changed = true;
            await writeFile(inputPath, `${original} `);
          }
        },
      }),
      (error: unknown) =>
        error instanceof CuratorError && error.code === "SOURCE_CHANGED_DURING_RUN",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("无 --force 时提交竞态不会覆盖后来创建的目标文件", async () => {
  const directory = await mkdtemp(join(tmpdir(), "curator-output-race-"));
  try {
    const inputPath = join(directory, "conversations.json");
    const outputPath = join(directory, "report.json");
    await writeFile(inputPath, "[]");
    const sink = await createJsonEventSink({ outputPath, sourcePath: inputPath, force: false });
    await sink.write({
      type: "header",
      schemaVersion: "1.3",
      generatedAt: "2026-01-01T00:00:00.000Z",
      source: {
        platform: "chatgpt",
        fileName: "conversations.json",
        sha256: `sha256:${Array(8).fill("00000000").join(":")}`,
        sizeBytes: 2,
      },
    });
    await writeFile(outputPath, "created-by-another-process", { flag: "wx" });
    await assert.rejects(
      () => sink.commit(),
      (error: unknown) => error instanceof CuratorError && error.code === "OUTPUT_EXISTS",
    );
    await sink.abort();
    assert.equal(await readFile(outputPath, "utf8"), "created-by-another-process");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("输出路径的硬链接和损坏符号链接具有安全覆盖语义", async () => {
  const directory = await mkdtemp(join(tmpdir(), "curator-output-links-"));
  try {
    const inputPath = join(directory, "conversations.json");
    const hardLinkPath = join(directory, "hard-link.json");
    const brokenLinkPath = join(directory, "broken-link.json");
    await writeFile(inputPath, "[]");
    await link(inputPath, hardLinkPath);
    await symlink(join(directory, "missing-target.json"), brokenLinkPath);

    await assert.rejects(
      () => createJsonEventSink({ outputPath: hardLinkPath, sourcePath: inputPath, force: true }),
      (error: unknown) =>
        error instanceof CuratorError && error.code === "OUTPUT_OVERWRITES_SOURCE",
    );
    await assert.rejects(
      () => createJsonEventSink({ outputPath: brokenLinkPath, sourcePath: inputPath, force: false }),
      (error: unknown) => error instanceof CuratorError && error.code === "OUTPUT_EXISTS",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("空数组返回明确的零项摘要", async () => {
  const directory = await mkdtemp(join(tmpdir(), "curator-empty-array-"));
  try {
    const inputPath = join(directory, "conversations.json");
    await writeFile(inputPath, "[]");
    const { result, events } = await collectRun(inputPath);

    assert.deepEqual(result.summary, {
      totalItems: 0,
      classified: 0,
      duplicates: 0,
      failed: 0,
      currentBranchParsed: 0,
      branchFallbacks: 0,
      contentUnavailable: 0,
      classificationTruncated: 0,
      s3: 0,
      s3Candidates: 0,
      suggestedAccept: 0,
      requiresReview: 0,
    });
    assert.deepEqual(events.map((event) => event.type), ["header", "summary"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI 默认只预览，显式 --write 后才流式导出", async () => {
  const directory = await mkdtemp(join(tmpdir(), "curator-cli-"));
  try {
    const inputPath = join(directory, "conversations.json");
    const outputPath = join(directory, "report.json");
    await writeFile(inputPath, JSON.stringify(syntheticExport(`sk-${"CliSynthetic8_".repeat(3)}`).slice(0, 2))); // gitleaks:allow -- constructed test-only token

    const preview = await execFileAsync(process.execPath, ["src/cli.ts", "--input", inputPath], {
      cwd: new URL("..", import.meta.url),
    });
    assert.match(preview.stdout, /只预览模式/u);
    await assert.rejects(() => readFile(outputPath));

    const exported = await execFileAsync(
      process.execPath,
      ["src/cli.ts", "--input", inputPath, "--write", "--output", outputPath],
      { cwd: new URL("..", import.meta.url) },
    );
    assert.match(exported.stdout, /报告已安全写入/u);
    assert.equal(exported.stdout.includes(outputPath), false);
    const events = JSON.parse(await readFile(outputPath, "utf8")) as ReportEvent[];
    const summary = events.find((event) => event.type === "summary");
    assert.equal(summary?.type === "summary" ? summary.summary.classified : null, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI 汇总模式不向工具回显逐条分类建议", async () => {
  const directory = await mkdtemp(join(tmpdir(), "curator-cli-summary-"));
  try {
    const inputPath = join(directory, "conversations.json");
    await writeFile(inputPath, JSON.stringify([{
      id: "summary-only",
      title: "合成分类标题 TypeScript API",
      current_node: "question",
      mapping: { question: node(null, "请整理 TypeScript API 任务", 1) },
    }]));

    const result = await execFileAsync(
      process.execPath,
      ["src/cli.ts", "--input", inputPath, "--summary-only"],
      { cwd: new URL("..", import.meta.url) },
    );
    assert.match(result.stdout, /已分类：1/u);
    assert.equal(result.stdout.includes("合成分类标题"), false);
    assert.equal(result.stdout.includes("conv:"), false);
    assert.equal(result.stdout.includes(inputPath), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI 不回显未知参数中的个人信息", async () => {
  const privateArgument = "--alice@example.com-13800138000";
  await assert.rejects(
    () =>
      execFileAsync(process.execPath, ["src/cli.ts", privateArgument], {
        cwd: new URL("..", import.meta.url),
      }),
    (error: unknown) => {
      const value = error as { stderr?: string; code?: number };
      return (
        value.code === 1 &&
        Boolean(value.stderr?.includes("UNKNOWN_ARGUMENT")) &&
        !value.stderr?.includes("alice@example.com") &&
        !value.stderr?.includes("13800138000")
      );
    },
  );
});

test("CLI 拒绝缺少值的路径参数且不把下一选项当作路径", async () => {
  for (const [arguments_, code] of [
    [["--input", "--write"], "INPUT_VALUE_REQUIRED"],
    [["--input", "synthetic.json", "--write", "--output", "--force"], "OUTPUT_VALUE_REQUIRED"],
  ] as const) {
    await assert.rejects(
      () => execFileAsync(process.execPath, ["src/cli.ts", ...arguments_], {
        cwd: new URL("..", import.meta.url),
      }),
      (error: unknown) => {
        const value = error as { stderr?: string; code?: number };
        return value.code === 1 && Boolean(value.stderr?.includes(code));
      },
    );
  }
});

test("CLI 在空格、中文、Unicode 符号和符号链接路径下均执行", async () => {
  const directory = await mkdtemp(join(tmpdir(), "curator-entry-"));
  const sourceProject = new URL("..", import.meta.url);
  try {
    for (const folder of ["project with space", "项目中文", "emoji-🚀-#"]) {
      const project = join(directory, folder);
      await copyCliRuntimeFixture(sourceProject, project);
      const execution = await execFileAsync(process.execPath, [join(project, "src/cli.ts"), "--help"]);
      assert.match(execution.stdout, /用法/u);
    }

    const realProject = join(directory, "real-project");
    const linkedProject = join(directory, "linked project");
    await copyCliRuntimeFixture(sourceProject, realProject);
    await symlink(realProject, linkedProject, "dir");
    const linkedExecution = await execFileAsync(
      process.execPath,
      [join(linkedProject, "src/cli.ts"), "--help"],
    );
    assert.match(linkedExecution.stdout, /用法/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI 拒绝非数组输入并清理未提交的流式报告", async () => {
  const directory = await mkdtemp(join(tmpdir(), "curator-cli-invalid-"));
  try {
    const inputPath = join(directory, "conversations.json");
    const outputPath = join(directory, "report.json");
    await writeFile(inputPath, "{}");

    await assert.rejects(
      () =>
        execFileAsync(
          process.execPath,
          ["src/cli.ts", "--input", inputPath, "--write", "--output", outputPath],
          { cwd: new URL("..", import.meta.url) },
        ),
      (error: unknown) => {
        const value = error as { stderr?: string; code?: number };
        return value.code === 1 && Boolean(value.stderr?.includes("INVALID_JSON_ARRAY"));
      },
    );
    await assert.rejects(() => readFile(outputPath));
    const remaining = await import("node:fs/promises").then(({ readdir }) => readdir(directory));
    assert.deepEqual(remaining, ["conversations.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI 对空数组返回非零状态而不伪装完成", async () => {
  const directory = await mkdtemp(join(tmpdir(), "curator-cli-empty-"));
  try {
    const inputPath = join(directory, "conversations.json");
    await writeFile(inputPath, "[]");
    await assert.rejects(
      () => execFileAsync(process.execPath, ["src/cli.ts", "--input", inputPath], {
        cwd: new URL("..", import.meta.url),
      }),
      (error: unknown) => {
        const value = error as { stdout?: string; code?: number };
        return value.code === 2 && Boolean(value.stdout?.includes("总项：0"));
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
