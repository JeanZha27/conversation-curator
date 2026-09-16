import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CuratorError } from "../src/core/errors.ts";
import { streamJsonObjectArray } from "../src/core/json-array-stream.ts";

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
