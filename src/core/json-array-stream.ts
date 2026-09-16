import { createReadStream } from "node:fs";
import { CuratorError } from "./errors.ts";

const MAX_ITEM_CHARACTERS = 8 * 1024 * 1024;

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

export async function* streamJsonObjectArray(
  filePath: string,
  signal?: AbortSignal,
): AsyncGenerator<JsonArrayItem> {
  if (signal?.aborted) throw abortError();

  const stream = createReadStream(filePath, {
    encoding: "utf8",
    highWaterMark: 64 * 1024,
  });
  const onAbort = () => stream.destroy(abortError());
  signal?.addEventListener("abort", onAbort, { once: true });

  let phase: "before-array" | "expect-value" | "in-value" | "after-value" | "done" =
    "before-array";
  let raw = "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  let offset = 0;
  let index = 0;
  let afterComma = false;

  try {
    for await (const chunk of stream) {
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
          raw = "{";
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

        raw += character;
        if (raw.length > MAX_ITEM_CHARACTERS) {
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
            yield { index, raw };
            index += 1;
            raw = "";
            phase = "after-value";
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
