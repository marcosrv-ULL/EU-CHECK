// services/openai.ts
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";

// Node < 20: asegura File/Blob globales para subidas
import { File as NodeFile, Blob as NodeBlob } from "node:buffer";
(globalThis as any).File ??= NodeFile;
(globalThis as any).Blob ??= NodeBlob;


function readApiKeyFromFile(): string | undefined {
  try {
    const p = path.resolve(process.cwd(), "API_KEY.key"); // fichero en la raíz del repo
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return undefined;
  }
}

const apiKey = process.env.OPENAI_API_KEY ?? readApiKeyFromFile();
if (!apiKey) {
  throw new Error("OPENAI_API_KEY no encontrada (ni en env ni en ./API_KEY)");
}

export const openai = new OpenAI({ apiKey });

/** Streaming de chat a texto plano (une únicamente los deltas de 'content') */
export async function* streamChatCompletion(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  model = "gpt-4o-mini",
  temperature = 1
): AsyncGenerator<string, void, unknown> {
  const stream = await openai.chat.completions.create({
    model,
    messages,
    temperature,
    stream: true,
  });

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) yield delta;
  }
}

/** Crea un embedding para un texto dado */
export async function createEmbedding(
  text: string,
  model = "text-embedding-3-small"
): Promise<number[]> {
  const resp = await openai.embeddings.create({ model, input: text });
  return resp.data[0].embedding as unknown as number[];
}
