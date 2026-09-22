function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stableConversationId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  for (const id of [value.id, value.conversation_id]) {
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return null;
}

export function isChatGptConversation(value: unknown): boolean {
  return isRecord(value) && isRecord(value.mapping) && stableConversationId(value) !== null;
}
