import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { parseChatGptConversation } from "../src/adapters/chatgpt.ts";
import { classifyConversation } from "../src/core/heuristic-classifier.ts";
import { assertOutputValueSafe, sanitizeClassificationContext, safeConversationReference } from "../src/core/output-sanitizer.ts";
import { scanSensitiveSegments, scanSensitiveText } from "../src/core/security-scanner.ts";
import { validateClassification } from "../src/core/result-validator.ts";

const exec = promisify(execFile);
const cwd = new URL("..", import.meta.url);

function classify(text: string) {
  return classifyConversation({
    sourceConversationId: safeConversationReference("synthetic-audit"),
    contentAvailable: true,
    classificationTruncated: false,
    branchMode: "current",
  }, { ...scanSensitiveText(text), redactedText: sanitizeClassificationContext(text) });
}

test("引用字段名与认证空白不能绕过凭据扫描或强制复核", () => {
  const value = "synthetic-value";
  const examples = [
    ...["password", "access_token", "API_KEY", "CLIENTSECRET", "密码"].flatMap(field => [
      JSON.stringify({ [field]: value }),
      `'${field}': '${value}'`,
    ]),
    ...["Bearer", "Basic"].flatMap(scheme => [" ", "\t", "\n", "\r\n"].map(
      whitespace => `Authorization: ${scheme}${whitespace}${"A".repeat(20)}`,
    )),
  ];
  for (const input of examples) {
    const scan = scanSensitiveText(input);
    assert.equal(scan.sensitivityLevel, "S3");
    assert.equal(scan.hardMatch, true);
    assert.notEqual(sanitizeClassificationContext(input), input);
    const result = classify(`typescript api done\n${input}`);
    assert.equal(result.requiresReview, true);
    assert.equal(result.sensitivityLevel, "S3");
    assert.deepEqual(validateClassification(result, { minimumSensitivity: "S3" }), []);
  }
});

test("输出扫描允许已知数字风险计数但拒绝凭据字符串和未知字段", () => {
  const keyName = ["API", "KEY"].join("_");
  const tokenName = ["ACCESS", "TOKEN"].join("_");
  const fieldName = ["pass", "word"].join("");
  assert.doesNotThrow(() => assertOutputValueSafe({ matchCounts: { [keyName]: 1, [tokenName]: 2 } }));
  assert.throws(() => assertOutputValueSafe({ [fieldName]: "x" }));
  assert.throws(() => assertOutputValueSafe({ matchCounts: { [keyName]: "x" } }));
  assert.throws(() => assertOutputValueSafe({ matchCounts: { [fieldName]: 1 } }));
});

test("安全扫描兼顾独立文本分片和跨分片凭据", () => {
  const prefix = ["s", "k-"].join("");
  const value = "A".repeat(20);
  for (const parts of [
    ["typescript api done", `${prefix}${value}`],
    ["typescript api done ", prefix, value],
  ]) {
    const parsed = parseChatGptConversation({
      id: "synthetic-parts", current_node: "only",
      mapping: { only: { parent: null, message: { content: { parts } } } },
    });
    assert.equal(parsed.messageCount, 1);
    const scan = scanSensitiveSegments(parsed.securityText, parsed.securityTextParts);
    assert.equal(scan.sensitivityLevel, "S3");
    assert.equal(scan.matchCounts.API_KEY, 1);
  }
});

test("否定和冲突状态不能被高置信度标记为已完成", () => {
  for (const text of ["unresolved", "not finished", "not done", "not resolved", "尚未完成", "done but pending"]) {
    const result = classify(`typescript api ${text}`);
    assert.notEqual(result.lifecycleStatus, "completed");
    assert.equal(result.requiresReview, true);
    assert.deepEqual(validateClassification(result), []);
  }
  const positive = classify("typescript api resolved");
  assert.equal(positive.lifecycleStatus, "completed");
});

async function expectSafeCliRejection(input: string, code: string, fifo = false): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "curator-audit-rejection-"));
  try {
    const runtime = join(directory, "runtime");
    await mkdir(runtime);
    const inputPath = join(directory, "input.json");
    const outputPath = join(directory, "report.json");
    if (fifo) await exec("mkfifo", [inputPath]);
    else await writeFile(inputPath, input);
    await assert.rejects(
      () => exec(process.execPath, ["src/cli.ts", "--input", inputPath, "--write", "--output", outputPath], {
        cwd, env: { ...process.env, TMPDIR: runtime, TMP: runtime, TEMP: runtime },
        timeout: 15_000, maxBuffer: 1024 * 1024,
      }),
      (error: unknown) => {
        const result = error as { code?: number; stderr?: string; stdout?: string; killed?: boolean };
        assert.equal(result.code, 1);
        assert.ok(result.stderr?.includes(`[${code}]`));
        assert.equal(result.killed, false);
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
        assert.equal(output.includes(directory), false);
        assert.equal(output.includes(process.execPath), false);
        assert.equal(output.includes("heap out of memory"), false);
        return true;
      },
    );
    assert.deepEqual(await readdir(runtime), []);
    assert.deepEqual((await readdir(directory)).sort(), ["input.json", "runtime"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("6 MB 结构密集输入在完整解析前拒绝且不残留原文或报告", async () => {
  const raw = `[{"id":"synthetic-oom","mapping":{},"extra":[${"{},".repeat(1_999_999)}{}]}]`;
  assert.ok(Buffer.byteLength(raw) < 8 * 1024 * 1024);
  await expectSafeCliRejection(raw, "INPUT_STRUCTURE_TOO_COMPLEX");
});

test("深层输入在完整解析前拒绝", async () => {
  await expectSafeCliRejection(`[{"id":"synthetic-depth","mapping":{},"extra":${"[".repeat(80)}0${"]".repeat(80)}}]`, "INPUT_STRUCTURE_TOO_COMPLEX");
});

test("FIFO 输入立即返回文件类型错误并清理临时报告", { skip: process.platform === "win32" }, async () => {
  await expectSafeCliRejection("", "INPUT_NOT_FILE", true);
});

for (const cleanupFailure of [false, true]) {
  test(`父进程处理子进程硬终止与原生诊断（清理失败=${cleanupFailure}）`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "curator-supervisor-regression-"));
    try {
      const runtime = join(directory, "runtime");
      await mkdir(runtime);
      const worker = join(directory, "worker.mjs");
      const runner = join(directory, "runner.mjs");
      const target = join(directory, "report.json");
      await writeFile(worker, `
        import { mkdir, writeFile } from 'node:fs/promises';
        import { writeSync } from 'node:fs';
        import { dirname, join } from 'node:path';
        import { randomUUID } from 'node:crypto';
        const start = await new Promise(resolve => process.once('message', resolve));
        await mkdir(join(start.temporaryRoot, 'snapshot'));
        await writeFile(join(start.temporaryRoot, 'snapshot', 'raw.json'), 'SYNTHETIC-RAW-PRIVATE-BODY');
        const temporary = join(dirname(process.argv[2]), '.report.json.' + process.pid + '.' + randomUUID() + '.tmp');
        const registered = new Promise(resolve => process.once('message', resolve));
        process.send({ type: 'temporary-report', path: temporary });
        await registered;
        ${cleanupFailure ? "await mkdir(temporary);" : "await writeFile(temporary, 'SYNTHETIC-PARTIAL-REPORT');"}
        writeSync(1, 'SYNTHETIC-NATIVE-STDOUT ' + process.execPath);
        writeSync(2, 'SYNTHETIC-NATIVE-STDERR ' + process.execPath);
        process.kill(process.pid, 'SIGKILL');
      `);
      await writeFile(runner, `
        import { superviseCli } from ${JSON.stringify(new URL("../src/core/cli-supervisor.ts", import.meta.url).href)};
        process.exitCode = await superviseCli(${JSON.stringify(worker)}, [${JSON.stringify(target)}], ${JSON.stringify(target)});
      `);
      await assert.rejects(() => exec(process.execPath, [runner], {
        env: { ...process.env, TMPDIR: runtime, TMP: runtime, TEMP: runtime }, timeout: 15_000,
      }), (error: unknown) => {
        const result = error as { code?: number; stdout?: string; stderr?: string };
        assert.equal(result.code, 1);
        assert.ok(result.stderr?.includes("[CLI_WORKER_FAILED]"));
        assert.equal(result.stderr?.includes("[OUTPUT_CLEANUP_FAILED]"), cleanupFailure);
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
        assert.equal(output.includes("SYNTHETIC-"), false);
        assert.equal(output.includes(process.execPath), false);
        assert.equal(output.includes(directory), false);
        return true;
      });
      assert.deepEqual(await readdir(runtime), []);
      assert.equal((await readdir(directory)).includes("report.json"), false);
      assert.equal((await readdir(directory)).filter(name => name.endsWith(".tmp")).length, cleanupFailure ? 1 : 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("父进程转发 SIGINT 并在工作进程取消后清理原文", async () => {
  const directory = await mkdtemp(join(tmpdir(), "curator-supervisor-cancel-"));
  try {
    const runtime = join(directory, "runtime");
    await mkdir(runtime);
    const worker = join(directory, "worker.mjs");
    const runner = join(directory, "runner.mjs");
    await writeFile(worker, `
      import { writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      process.once('disconnect', () => process.exit(1));
      process.once('SIGINT', () => {
        process.send({ type: 'complete', exitCode: 130 }, () => process.exit(130));
      });
      const start = await new Promise(resolve => process.once('message', resolve));
      await writeFile(join(start.temporaryRoot, 'raw.json'), 'SYNTHETIC-RAW-BODY');
      process.send({ type: 'output', channel: 'stdout', value: 'WORKER_READY' });
    `);
    await writeFile(runner, `
      import { superviseCli } from ${JSON.stringify(new URL("../src/core/cli-supervisor.ts", import.meta.url).href)};
      process.exitCode = await superviseCli(${JSON.stringify(worker)}, [], null);
    `);
    const result = await new Promise<{ code: number | null; output: string }>((resolveResult, reject) => {
      const child = spawn(process.execPath, [runner], {
        env: { ...process.env, TMPDIR: runtime, TMP: runtime, TEMP: runtime }, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("supervisor cancellation timed out")); }, 10_000);
      child.stdout.on("data", chunk => {
        output += chunk.toString();
        if (output.includes("WORKER_READY")) child.kill("SIGINT");
      });
      child.stderr.on("data", chunk => { output += chunk.toString(); });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); resolveResult({ code, output }); });
    });
    assert.equal(result.code, 130);
    assert.equal(result.output.includes(directory), false);
    assert.equal(result.output.includes("SYNTHETIC-RAW-BODY"), false);
    assert.deepEqual(await readdir(runtime), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
