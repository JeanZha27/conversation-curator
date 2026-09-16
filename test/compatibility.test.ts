import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkCompatibility } from "../scripts/compatibility-check.ts";
import { CuratorError } from "../src/core/errors.ts";

test("私有兼容检查在样本缺失时保持阻塞", async () => {
  const directory = await mkdtemp(join(tmpdir(), "curator-private-missing-"));
  try {
    await assert.rejects(
      () => checkCompatibility(join(directory, "conversations.json")),
      (error: unknown) =>
        error instanceof CuratorError &&
        error.code === "PRIVATE_SAMPLE_MISSING" &&
        error.exitCode === 2,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("私有兼容检查只返回汇总计数且不产生报告文件", async () => {
  const directory = await mkdtemp(join(tmpdir(), "curator-private-synthetic-"));
  try {
    const inputPath = join(directory, "conversations.json");
    await writeFile(
      inputPath,
      JSON.stringify([
        {
          id: "synthetic-compatibility-1",
          title: "验证 ChatGPT 导出兼容性",
          current_node: "message",
          mapping: {
            message: {
              parent: null,
              message: { create_time: 1, content: { parts: ["仅用于合成结构测试"] } },
            },
          },
        },
      ]),
    );

    const summary = await checkCompatibility(inputPath);
    assert.equal(summary.totalItems, 1);
    assert.equal(summary.classified, 1);
    assert.equal(summary.failed, 0);
    await assert.rejects(() => import("node:fs/promises").then(({ access }) => access(join(directory, "report.json"))));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
