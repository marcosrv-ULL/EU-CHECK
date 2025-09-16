export type MemoryEntry = { role: "user" | "assistant"; text: string };

const sessionMemory = new WeakMap<any, MemoryEntry[]>();
const MAX_MEMORY_ENTRIES = 6;

export function pushMemory(ws: any, entry: MemoryEntry) {
  const arr = sessionMemory.get(ws) ?? [];
  arr.push(entry);
  while (arr.length > MAX_MEMORY_ENTRIES) arr.shift();
  sessionMemory.set(ws, arr);
}

export function buildMemorySystem(ws: any): string | "" {
  const arr = sessionMemory.get(ws);
  if (!arr || arr.length === 0) return "";
  const brief = arr
    .map((m) => (m.role === "user" ? `User: ${m.text}` : `Assistant: ${m.text}`))
    .join("\n")
    .slice(0, 1200);
  return `SESSION MEMORY (brief, last ${arr.length} turns):\n${brief}`;
}
