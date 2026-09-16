import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
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
    await writeFile(inputPath, JSON.stringify(syntheticExport(`sk-${"CliSynthetic8_".repeat(3)}`))); // gitleaks:allow -- constructed test-only token

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
    assert.match(exported.stdout, /报告已写入/u);
    const events = JSON.parse(await readFile(outputPath, "utf8")) as ReportEvent[];
    const summary = events.find((event) => event.type === "summary");
    assert.equal(summary?.type === "summary" ? summary.summary.classified : null, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI 在空格、中文、Unicode 符号和符号链接路径下均执行", async () => {
  const directory = await mkdtemp(join(tmpdir(), "curator-entry-"));
  const sourceProject = new URL("..", import.meta.url);
  try {
    for (const folder of ["project with space", "项目中文", "emoji-🚀-#"]) {
      const project = join(directory, folder);
      await cp(sourceProject, project, { recursive: true });
      const execution = await execFileAsync(process.execPath, [join(project, "src/cli.ts"), "--help"]);
      assert.match(execution.stdout, /用法/u);
    }

    const realProject = join(directory, "real-project");
    const linkedProject = join(directory, "linked project");
    await cp(sourceProject, realProject, { recursive: true });
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
