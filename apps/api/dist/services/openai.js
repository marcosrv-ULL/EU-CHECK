var _a, _b;
// services/openai.ts
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
// Node < 20: asegura File/Blob globales para subidas
import { File as NodeFile, Blob as NodeBlob } from "node:buffer";
(_a = globalThis).File ?? (_a.File = NodeFile);
(_b = globalThis).Blob ?? (_b.Blob = NodeBlob);
function readApiKeyFromFile() {
    try {
        const p = path.resolve(process.cwd(), "API_KEY.key"); // fichero en la raíz del repo
        return fs.readFileSync(p, "utf8").trim();
    }
    catch {
        return undefined;
    }
}
const apiKey = process.env.OPENAI_API_KEY ?? readApiKeyFromFile();
if (!apiKey) {
    throw new Error("OPENAI_API_KEY no encontrada (ni en env ni en ./API_KEY)");
}
export const openai = new OpenAI({ apiKey });
/** Streaming de chat a texto plano (une únicamente los deltas de 'content') */
export async function* streamChatCompletion(messages, model = "gpt-4o-mini", temperature = 1) {
    const stream = await openai.chat.completions.create({
        model,
        messages,
        temperature,
        stream: true,
    });
    for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta)
            yield delta;
    }
}
/** Crea un embedding para un texto dado */
export async function createEmbedding(text, model = "text-embedding-3-small") {
    const resp = await openai.embeddings.create({ model, input: text });
    return resp.data[0].embedding;
}
