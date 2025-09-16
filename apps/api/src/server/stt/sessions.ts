export type SttBuf = { chunks: Buffer[]; mime: string; lang?: string };
export const sttSessions = new Map<string, SttBuf>();
