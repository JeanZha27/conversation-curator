import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { approvedMarkerCount, isApprovedSyntheticMarker } from "../scripts/approved-synthetic-markers.ts";
import { isApprovedGitleaksConfig } from "../scripts/approved-gitleaks-config.ts";
import { isApprovedGitleaksIgnore } from "../scripts/approved-gitleaks-ignore.ts";
import { scanSensitiveText } from "../src/core/security-scanner.ts";

test("仓库豁免只允许已审查的精确合成行", async () => {
  const path = "test/core.test.ts";
  const marker = ["gitleaks", "allow"].join(":");
  const source = await readFile(new URL("./core.test.ts", import.meta.url), "utf8");
  const approved = source.split(/\r?\n/u).find((line) => line.includes(marker));
  assert.ok(approved);
  assert.ok(approvedMarkerCount > 0);
  assert.equal(isApprovedSyntheticMarker(path, approved), true);
  const injected = `${approved} ${["API", "KEY=syntheticvalue"].join("")}`;
  assert.equal(scanSensitiveText(injected).hardMatch, true);
  assert.equal(isApprovedSyntheticMarker(path, injected), false);
  assert.equal(isApprovedSyntheticMarker("test/other.test.ts", approved), false);
  assert.equal(isApprovedSyntheticMarker(path, `new synthetic line // ${marker}`), false);
  assert.equal(isApprovedSyntheticMarker("notes.txt", `synthetic note // ${marker}`), false);
});

test("Gitleaks 配置只接受已审查版本，拒绝新增全匹配豁免", async () => {
  const config = await readFile(new URL("../.gitleaks.toml", import.meta.url), "utf8");
  assert.equal(isApprovedGitleaksConfig(config), true);
  const widened = config.replace("regexes = [\n", "regexes = [\n  '''^.*$''',\n");
  assert.notEqual(widened, config);
  assert.equal(isApprovedGitleaksConfig(widened), false);
});

test("Gitleaks 历史豁免只接受一条已审查指纹", async () => {
  const ignore = await readFile(new URL("../.gitleaksignore", import.meta.url), "utf8");
  assert.equal(isApprovedGitleaksIgnore(ignore), true);
  assert.equal(isApprovedGitleaksIgnore(`${ignore}another:fingerprint\n`), false);
  assert.equal(isApprovedGitleaksIgnore(ignore.replace("private-key:121", "private-key:122")), false);
});
