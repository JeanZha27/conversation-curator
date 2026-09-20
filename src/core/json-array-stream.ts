import { createReadStream } from "node:fs";
import { CuratorError } from "./errors.ts";

export const MAX_ITEM_BYTES = 8 * 1024 * 1024;

export type JsonArrayItem = {
  index: number;
  raw: string;
};

function abortError(): Error {
  const error = new Error("操作已取消。");
  error.name = "AbortError";
  return error;
}

function parseError(offset: number, detail: string): CuratorError {
  return new CuratorError(
    "INVALID_JSON_ARRAY",
    `输入不是受支持的 JSON 对象数组（字符位置 ${offset}：${detail}）。`,
  );
}

function utf8Bytes(character: string): number {
  const codePoint = character.codePointAt(0)!;
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

async function* decodeUtf8(
  chunks: AsyncIterable<Buffer | string>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for await (const chunk of chunks) {
      yield typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    }
    const final = decoder.decode();
    if (final) yield final;
  } catch {
    throw new CuratorError("INVALID_UTF8", "输入文件不是有效的 UTF-8 文本。");
  }
}

export async function* streamJsonObjectArray(
  filePath: string,
  signal?: AbortSignal,
): AsyncGenerator<JsonArrayItem> {
  if (signal?.aborted) throw abortError();

  const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
  const onAbort = () => stream.destroy(abortError());
  signal?.addEventListener("abort", onAbort, { once: true });

  let phase: "before-array" | "expect-value" | "in-value" | "after-value" | "done" =
    "before-array";
  let rawSegments: string[] = [];
  let rawCharacters: string[] = [];
  let rawBytes = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let offset = 0;
  let index = 0;
  let afterComma = false;

  function appendRaw(character: string): void {
    rawCharacters.push(character);
    if (rawCharacters.length >= 4096) {
      rawSegments.push(rawCharacters.join(""));
      rawCharacters = [];
    }
  }

  function takeRaw(): string {
    if (rawCharacters.length > 0) rawSegments.push(rawCharacters.join(""));
    const value = rawSegments.join("");
    rawSegments = [];
    rawCharacters = [];
    return value;
  }

  try {
    for await (const chunk of decodeUtf8(stream)) {
      if (signal?.aborted) throw abortError();

      for (const character of chunk) {
        offset += 1;

        if (phase === "before-array") {
          if (/\s/u.test(character)) continue;
          if (character !== "[") throw parseError(offset, "顶层必须是数组");
          phase = "expect-value";
          continue;
        }

        if (phase === "done") {
          if (!/\s/u.test(character)) throw parseError(offset, "数组结束后仍有内容");
          continue;
        }

        if (phase === "expect-value") {
          if (/\s/u.test(character)) continue;
          if (character === "]") {
            if (afterComma) throw parseError(offset, "不允许尾随逗号");
            phase = "done";
            continue;
          }
          if (character !== "{") throw parseError(offset, "数组元素必须是对象");
          rawSegments = [];
          rawCharacters = ["{"];
          rawBytes = 1;
          depth = 1;
          inString = false;
          escaped = false;
          phase = "in-value";
          afterComma = false;
          continue;
        }

        if (phase === "after-value") {
          if (/\s/u.test(character)) continue;
          if (character === ",") {
            phase = "expect-value";
            afterComma = true;
            continue;
          }
          if (character === "]") {
            phase = "done";
            continue;
          }
          throw parseError(offset, "数组元素之间需要逗号");
        }

        appendRaw(character);
        rawBytes += utf8Bytes(character);
        if (rawBytes > MAX_ITEM_BYTES) {
          throw new CuratorError(
            "CONVERSATION_TOO_LARGE",
            `第 ${index + 1} 个对话超过 8 MiB 单项安全上限。`,
          );
        }

        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (character === "\\") {
            escaped = true;
          } else if (character === '"') {
            inString = false;
          }
          continue;
        }

        if (character === '"') {
          inString = true;
        } else if (character === "{" || character === "[") {
          depth += 1;
        } else if (character === "}" || character === "]") {
          depth -= 1;
          if (depth < 0) throw parseError(offset, "括号不匹配");
          if (depth === 0) {
            const completedIndex = index;
            const completedRaw = takeRaw();
            index += 1;
            rawBytes = 0;
            phase = "after-value";
            yield { index: completedIndex, raw: completedRaw };
          }
        }
      }
    }

    if (phase === "before-array") throw parseError(offset, "文件为空");
    if (phase === "in-value") throw parseError(offset, "对象未闭合");
    if (phase === "expect-value" && afterComma) throw parseError(offset, "数组在逗号后结束");
    if (phase !== "done") throw parseError(offset, "数组未闭合");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    stream.destroy();
  }
}
