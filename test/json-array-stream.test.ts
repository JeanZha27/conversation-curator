import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CuratorError } from "../src/core/errors.ts";
import { MAX_ITEM_BYTES, streamJsonObjectArray } from "../src/core/json-array-stream.ts";

async function collect(path: string): Promise<unknown[]> {
  const values: unknown[] = [];
  for await (const item of streamJsonObjectArray(path)) values.push(JSON.parse(item.raw));
  return values;
}

test("增量读取跨 chunk 的顶层对象数组", async () => {
  const directory = await mkdtemp(join(tmpdir(), "curator-stream-"));
  try {
    const path = join(directory, "conversations.json");
    const longText = `边界-${"x".repeat(70_000)}-结束`;
    await writeFile(path, JSON.stringify([{ id: "one", text: longText }, { id: "two" }]));

    const values = await collect(path) as Array<{ id: string; text?: string }>;
    assert.equal(values.length, 2);
    assert.equal(values[0]!.id, "one");
    assert.equal(values[0]!.text, longText);
    assert.equal(values[1]!.id, "two");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("拒绝非数组和尾随逗号", async () => {
  const directory = await mkdtemp(join(tmpdir(), "curator-stream-invalid-"));
  try {
    for (const [name, content] of [["object.json", "{}"], ["trailing.json", "[{},]"]] as const) {
      const path = join(directory, name);
      await writeFile(path, content);
      await assert.rejects(
        async () => collect(path),
        (error: unknown) => error instanceof CuratorError && error.code === "INVALID_JSON_ARRAY",
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("拒绝无效 UTF-8 而不是静默替换字符", async () => {
  const directory = await mkdtemp(join(tmpdir(), "curator-stream-utf8-"));
  try {
    const path = join(directory, "invalid.json");
    await writeFile(path, Buffer.from([0x5b, 0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d, 0x5d]));
    await assert.rejects(
      async () => collect(path),
      (error: unknown) => error instanceof CuratorError && error.code === "INVALID_UTF8",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("读取期间取消保留 AbortError 而不是误报 INVALID_UTF8", async () => {
  const directory = await mkdtemp(join(tmpdir(), "curator-stream-abort-"));
  try {
    const path = join(directory, "conversations.json");
    await writeFile(path, `[{"id":"one"},${" ".repeat(128 * 1024)}{"id":"two"}]`);
    const controller = new AbortController();
    const iterator = streamJsonObjectArray(path, controller.signal);

    const first = await iterator.next();
    assert.equal(first.done, false);
    assert.equal(JSON.parse(first.value!.raw).id, "one");
    controller.abort();

    await assert.rejects(
      () => iterator.next(),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("8 MiB 单项上限按 UTF-8 字节而不是 UTF-16 字符执行", async () => {
  const directory = await mkdtemp(join(tmpdir(), "curator-stream-byte-limit-"));
  try {
    const path = join(directory, "conversations.json");
    const oversizedChinese = "界".repeat(Math.floor(MAX_ITEM_BYTES / 3) + 1);
    await writeFile(path, JSON.stringify([{ id: "one", text: oversizedChinese }]));

    await assert.rejects(
      async () => collect(path),
      (error: unknown) =>
        error instanceof CuratorError && error.code === "CONVERSATION_TOO_LARGE",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
