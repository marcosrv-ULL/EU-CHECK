var _a, _b;
// index.ts
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { randomUUID } from "crypto";
import { streamChatCompletion } from "./services/openai";
import { SentenceChunker } from "./chunker";
import { spawn } from "node:child_process";
import path from "node:path";
import { indexDir, topK } from "./services/knowledge";
import { createEmbedding } from "./services/openai";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import { openai } from "./services/openai"; // ya lo tienes
const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
await app.register(websocket);
app.get("/api/health", async () => ({ ok: true }));
/** ======= Carga de conocimiento (RAG) ======= */
let knowledgeIndex = [];
const knowledgeDir = path.resolve(process.cwd(), "knowledge");
try {
    knowledgeIndex = await indexDir(knowledgeDir);
    app.log.info(`RAG: indexados ${knowledgeIndex.length} fragmentos desde ${knowledgeDir}`);
}
catch (e) {
    app.log.warn(`RAG: no se pudo cargar carpeta ${knowledgeDir} (${e?.message ?? e})`);
}
const sessionMemory = new WeakMap();
const MAX_MEMORY_ENTRIES = 6;
function pushMemory(ws, entry) {
    const arr = sessionMemory.get(ws) ?? [];
    arr.push(entry);
    while (arr.length > MAX_MEMORY_ENTRIES)
        arr.shift();
    sessionMemory.set(ws, arr);
}
function buildMemorySystem(ws) {
    const arr = sessionMemory.get(ws);
    if (!arr || arr.length === 0)
        return "";
    const brief = arr
        .map((m) => (m.role === "user" ? `User: ${m.text}` : `Assistant: ${m.text}`))
        .join("\n")
        .slice(0, 1200);
    return `SESSION MEMORY (brief, last ${arr.length} turns):\n${brief}`;
}
import { File as NodeFile, Blob as NodeBlob } from "node:buffer";
(_a = globalThis).File ?? (_a.File = NodeFile);
(_b = globalThis).Blob ?? (_b.Blob = NodeBlob);
/** Convierte a WAV PCM16 mono 16k con ffmpeg (robusto para WebM/Ogg) */
async function toWavPcm16(buf, mime = "audio/webm") {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "stt-"));
    const inExt = mime.includes("ogg") ? "ogg" : mime.includes("webm") ? "webm" : "wav";
    const inPath = path.join(tmp, `in.${inExt}`);
    const outPath = path.join(tmp, `out.wav`);
    await fsp.writeFile(inPath, buf);
    await new Promise((resolve, reject) => {
        const ff = spawn("ffmpeg", ["-y", "-i", inPath, "-ac", "1", "-ar", "16000", outPath], {
            stdio: ["ignore", "ignore", "inherit"],
        });
        ff.on("error", reject);
        ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
    });
    const wav = await fsp.readFile(outPath);
    await fsp.rm(tmp, { recursive: true, force: true });
    return wav;
}
const sttSessions = new Map();
/** ======= Piper TTS → Buffer WAV ======= */
async function synthesizeWithPiper(text, voiceBase) {
    const voicesDir = path.resolve(process.cwd(), "voices");
    const model = path.join(voicesDir, `${voiceBase}.onnx`);
    const config = path.join(voicesDir, `${voiceBase}.onnx.json`);
    return new Promise((resolve, reject) => {
        const chunks = [];
        const child = spawn("piper", ["--model", model, "--config", config, "--output_file", "-"], {
            stdio: ["pipe", "pipe", "inherit"],
        });
        child.stdin.write(text);
        child.stdin.end();
        child.stdout.on("data", (c) => chunks.push(c));
        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0)
                resolve(Buffer.concat(chunks));
            else
                reject(new Error(`Piper exited with code ${code}`));
        });
    });
}
async function transcribeOnce(buf) {
    // volcamos WAV a fichero temporal y lo subimos como stream
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "stt-"));
    const filePath = path.join(tmp, `input.wav`);
    await fsp.writeFile(filePath, buf);
    try {
        const rs = fs.createReadStream(filePath);
        const resp = await openai.audio.transcriptions.create({
            model: "gpt-4o-transcribe",
            file: rs,
            // language: "en", // opcional si quieres fijar idioma
        });
        return resp.text ?? "";
    }
    finally {
        await fsp.rm(tmp, { recursive: true, force: true });
    }
}
/** ======= WS chat ======= */
app.get("/api/chat/ws", { websocket: true }, (conn) => {
    conn.socket.on("message", async (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        }
        catch {
            return;
        }
        const turnId = msg.turnId ?? randomUUID();
        const replyBase = { v: 1, turnId, replyTo: msg.msgId, t: Date.now() };
        switch (msg.type) {
            /* ======= STT: iniciar sesión ======= */
            case "stt_start": {
                const sessionId = msg?.data?.sessionId;
                const lang = msg?.data?.lang;
                const mime = msg?.data?.mime || "audio/webm";
                if (!sessionId)
                    return;
                sttSessions.set(sessionId, { chunks: [], mime, lang });
                conn.socket.send(JSON.stringify({
                    ...replyBase,
                    type: "stt_ack",
                    msgId: randomUUID(),
                    data: { sessionId },
                }));
                return;
            }
            /* ======= STT: recibir trozos base64 ======= */
            case "stt_audio": {
                const { sessionId, b64 } = msg.data || {};
                const s = sttSessions.get(sessionId);
                if (!s || !b64)
                    return;
                try {
                    s.chunks.push(Buffer.from(b64, "base64"));
                }
                catch (e) {
                    conn.socket.send(JSON.stringify({
                        ...replyBase,
                        type: "stt_error",
                        msgId: randomUUID(),
                        data: { sessionId, message: e?.message ?? "Malformed audio chunk" },
                    }));
                }
                return;
            }
            /* ======= STT: finalizar, transcribir y responder ======= */
            case "stt_end": {
                const { sessionId } = msg.data || {};
                const s = sttSessions.get(sessionId);
                if (!s)
                    return;
                try {
                    const full = Buffer.concat(s.chunks);
                    // 👇 convertir SIEMPRE a WAV 16k mono
                    const wavBuf = await toWavPcm16(full, s.mime);
                    const text = await transcribeOnce(wavBuf);
                    conn.socket.send(JSON.stringify({
                        ...replyBase, type: "stt_result", msgId: randomUUID(),
                        data: { sessionId, text }
                    }));
                }
                catch (e) {
                    conn.socket.send(JSON.stringify({
                        ...replyBase, type: "stt_error", msgId: randomUUID(),
                        data: { sessionId, message: e?.message ?? "Transcription failed" }
                    }));
                }
                finally {
                    sttSessions.delete(sessionId);
                }
                return;
            }
            /* ======= CHAT normal (tu flujo existente) ======= */
            case "user_text": {
                const userText = msg.data?.text ?? "";
                const wantTTS = !!msg.data?.tts;
                const voiceBase = msg.data?.voice || "en_US-ryan-high";
                // ===== Persona: Avatar 3 – Taylor Rivera =====
                const persona = [
                    "You are Taylor Rivera, a panelist persona.",
                    "Traits: critical thinker; detail-oriented investigator; rights-driven advocate; ethically uncompromising; skeptical of hype; patient educator; community-minded collaborator.",
                    "Tone: calm, precise, rights-focused. Challenge hype, explain trade-offs, prefer concrete examples, avoid sensationalism.",
                ].join(" ");
                // ===== Reglas de estilo y seguridad (conciso + citas RAG + anti-alucinación) =====
                const rails = [
                    "Be concise by default: 2–4 short sentences. If the user explicitly asks for more detail, add 1–2 extra sentences.",
                    "Use provided CONTEXT when relevant and cite with [ctx:n] where n matches the numbering in the CONTEXT.",
                    "Do not fabricate sources. Only use [ctx:n] for facts that come from the CONTEXT. If unsure or missing info, say so and ask at most one clarifying question.",
                    "Respond in the user's language when possible.",
                ].join(" ");
                // ===== Memoria de sesión breve =====
                const memorySystem = buildMemorySystem(conn.socket);
                // ===== RAG: recupera pasajes relevantes (si hay índice) =====
                let ctxBlock = "";
                let ctxMeta = [];
                if (knowledgeIndex.length > 0 && userText.trim().length > 0) {
                    try {
                        const qEmb = await createEmbedding(userText);
                        const hits = topK(qEmb, knowledgeIndex, 6);
                        ctxBlock = hits.map((h, i) => `[ctx:${i + 1}] (${h.source}) ${h.text}`).join("\n\n");
                        ctxMeta = hits.map((h, i) => ({ n: i + 1, id: h.id, source: h.source, text: h.text }));
                    }
                    catch (e) {
                        app.log.warn(`RAG: fallo en recuperación (${e?.message ?? e})`);
                    }
                }
                // Informa al cliente de las fuentes (útil para UI)
                if (ctxMeta.length) {
                    conn.socket.send(JSON.stringify({
                        ...replyBase,
                        type: "ctx_sources",
                        msgId: randomUUID(),
                        data: {
                            sources: ctxMeta.map((s) => ({
                                n: s.n,
                                id: s.id,
                                source: s.source,
                                preview: s.text.slice(0, 240),
                            })),
                        },
                    }));
                }
                // ===== Construye mensajes del LLM =====
                const messages = [
                    { role: "system", content: persona },
                    { role: "system", content: rails },
                    ...(memorySystem ? [{ role: "system", content: memorySystem }] : []),
                    ...(ctxBlock ? [{ role: "system", content: `CONTEXT:\n${ctxBlock}` }] : []),
                    { role: "user", content: userText },
                ];
                // ===== Streaming + Sentence chunker + TTS =====
                const chunker = new SentenceChunker({ gapMs: 380 });
                let tokenSeq = 0;
                let sentenceIndex = 0;
                const assistantParts = [];
                // Guarda en memoria el input del usuario
                pushMemory(conn.socket, { role: "user", text: userText });
                try {
                    for await (const delta of streamChatCompletion(messages)) {
                        // 1) tokens live
                        conn.socket.send(JSON.stringify({
                            ...replyBase,
                            type: "llm_token",
                            msgId: randomUUID(),
                            data: { text: delta, seq: tokenSeq++ },
                        }));
                        // 2) oraciones + TTS opcional
                        const sentences = chunker.push(delta);
                        for (const s of sentences) {
                            assistantParts.push(s);
                            conn.socket.send(JSON.stringify({
                                ...replyBase,
                                type: "sentence",
                                msgId: randomUUID(),
                                data: { text: s, index: sentenceIndex },
                            }));
                            if (wantTTS) {
                                (async () => {
                                    try {
                                        const wav = await synthesizeWithPiper(s, voiceBase);
                                        conn.socket.send(JSON.stringify({
                                            ...replyBase,
                                            type: "tts_chunk",
                                            msgId: randomUUID(),
                                            data: {
                                                sentenceIndex,
                                                mime: "audio/wav",
                                                audioB64: wav.toString("base64"),
                                            },
                                        }));
                                    }
                                    catch (err) {
                                        conn.socket.send(JSON.stringify({
                                            ...replyBase,
                                            type: "tts_error",
                                            msgId: randomUUID(),
                                            data: {
                                                sentenceIndex,
                                                message: err?.message ?? "Piper failed",
                                            },
                                        }));
                                    }
                                })();
                            }
                            sentenceIndex++;
                        }
                    }
                    // 3) flush de cola como última oración (+ TTS)
                    const tail = chunker.flush();
                    if (tail) {
                        assistantParts.push(tail);
                        conn.socket.send(JSON.stringify({
                            ...replyBase,
                            type: "sentence",
                            msgId: randomUUID(),
                            data: { text: tail, index: sentenceIndex },
                        }));
                        if (wantTTS) {
                            (async () => {
                                try {
                                    const wav = await synthesizeWithPiper(tail, voiceBase);
                                    conn.socket.send(JSON.stringify({
                                        ...replyBase,
                                        type: "tts_chunk",
                                        msgId: randomUUID(),
                                        data: {
                                            sentenceIndex,
                                            mime: "audio/wav",
                                            audioB64: wav.toString("base64"),
                                        },
                                    }));
                                }
                                catch (err) {
                                    conn.socket.send(JSON.stringify({
                                        ...replyBase,
                                        type: "tts_error",
                                        msgId: randomUUID(),
                                        data: {
                                            sentenceIndex,
                                            message: err?.message ?? "Piper failed",
                                        },
                                    }));
                                }
                            })();
                        }
                    }
                    // 4) done
                    conn.socket.send(JSON.stringify({
                        ...replyBase,
                        type: "done",
                        msgId: randomUUID(),
                        data: {},
                    }));
                    // 5) añade respuesta completa a la memoria
                    const assistantFull = assistantParts.join(" ").trim();
                    if (assistantFull)
                        pushMemory(conn.socket, { role: "assistant", text: assistantFull });
                }
                catch (e) {
                    app.log.error(e);
                    conn.socket.send(JSON.stringify({
                        ...replyBase,
                        type: "error",
                        msgId: randomUUID(),
                        data: { code: "OPENAI_ERROR", message: e?.message ?? "OpenAI call failed" },
                    }));
                }
                return;
            }
            default:
                return;
        }
    });
});
const port = Number(process.env.PORT || 3000);
app.listen({ port, host: "0.0.0.0" });
