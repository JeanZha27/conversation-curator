import { isChatGptConversation } from "../src/core/chatgpt-shape.ts";

export function resemblesPrivateArtifact(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (value.some(isChatGptConversation)) return true;
  const eventTypes = new Set(value.flatMap(entry =>
    typeof entry === "object" && entry !== null && !Array.isArray(entry) ? [entry.type] : [],
  ));
  return eventTypes.has("header") && eventTypes.has("summary");
}
