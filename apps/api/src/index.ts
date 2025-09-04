// index.ts
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { randomUUID } from "crypto";
import { streamChatCompletion } from "./services/openai";
import { SentenceChunker } from "./chunker";
import { spawn } from "node:child_process";
import path from "node:path";
import { indexDir, topK, DocChunk } from "./services/knowledge";
import { createEmbedding, openai } from "./services/openai";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";

// 👇 Añadidos para el proxy HTTP hacia el microservicio Vosk
import { FormData, File as NodeFile } from "formdata-node";
import { fetch } from "undici";

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(websocket);

app.get("/api/health", async () => ({ ok: true }));

/** ======= Carga de conocimiento (RAG) ======= */
let knowledgeIndex: (DocChunk & { rank?: number })[] = [];
const knowledgeDir = path.resolve(process.cwd(), "knowledge");

try {
  knowledgeIndex = await indexDir(knowledgeDir);
  app.log.info(`RAG: indexados ${knowledgeIndex.length} fragmentos desde ${knowledgeDir}`);
} catch (e: any) {
  app.log.warn(`RAG: no se pudo cargar carpeta ${knowledgeDir} (${e?.message ?? e})`);
}

/** ======= Memoria de sesión por conexión ======= */
type MemoryEntry = { role: "user" | "assistant"; text: string };
const sessionMemory = new WeakMap<any, MemoryEntry[]>();
const MAX_MEMORY_ENTRIES = 6;

function pushMemory(ws: any, entry: MemoryEntry) {
  const arr = sessionMemory.get(ws) ?? [];
  arr.push(entry);
  while (arr.length > MAX_MEMORY_ENTRIES) arr.shift();
  sessionMemory.set(ws, arr);
}

function buildMemorySystem(ws: any): string | "" {
  const arr = sessionMemory.get(ws);
  if (!arr || arr.length === 0) return "";
  const brief = arr
    .map((m) => (m.role === "user" ? `User: ${m.text}` : `Assistant: ${m.text}`))
    .join("\n")
    .slice(0, 1200);
  return `SESSION MEMORY (brief, last ${arr.length} turns):\n${brief}`;
}

/** Extrae PCM16 mono de un WAV y devuelve Int16Array + sampleRate */
function parseWavPcm16(wav: Buffer): { pcm: Int16Array; sampleRate: number } {
  // Formato: RIFF/WAVE, fmt chunk, data chunk (PCM16 mono/stereo)
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a WAV file");
  }
  let offset = 12; // after "RIFF....WAVE"
  let fmtChunkOffset = -1;
  let dataChunkOffset = -1;
  let dataChunkLen = 0;
  let audioFormat = 1; // PCM
  let numChannels = 1;
  let sampleRate = 16000;
  let bitsPerSample = 16;

  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const next = offset + 8 + size;

    if (id === "fmt ") {
      fmtChunkOffset = offset + 8;
      audioFormat = wav.readUInt16LE(fmtChunkOffset + 0);
      numChannels = wav.readUInt16LE(fmtChunkOffset + 2);
      sampleRate = wav.readUInt32LE(fmtChunkOffset + 4);
      bitsPerSample = wav.readUInt16LE(fmtChunkOffset + 14);
    } else if (id === "data") {
      dataChunkOffset = offset + 8;
      dataChunkLen = size;
      break;
    }
    offset = next;
  }

  if (audioFormat !== 1) throw new Error("Only PCM WAV supported");
  if (bitsPerSample !== 16) throw new Error("Only 16-bit WAV supported");
  if (dataChunkOffset < 0) throw new Error("WAV data chunk not found");

  // Si viene estéreo, hacemos downmix sencillo a mono
  const sampleCount = (dataChunkLen / 2) | 0;
  const pcmAll = new Int16Array(wav.buffer, wav.byteOffset + dataChunkOffset, sampleCount);

  if (numChannels === 1) {
    return { pcm: new Int16Array(pcmAll), sampleRate };
  } else if (numChannels === 2) {
    const mono = new Int16Array(sampleCount / 2);
    for (let i = 0, j = 0; j < mono.length; i += 2, j++) {
      // downmix L+R/2
      mono[j] = ((pcmAll[i] + pcmAll[i + 1]) / 2) | 0;
    }
    return { pcm: mono, sampleRate };
  } else {
    throw new Error(`Unsupported channels: ${numChannels}`);
  }
}

/** Devuelve niveles RMS normalizados [0..1] por frames de 'winMs' (ej. 40ms) */
function rmsLevelsFromPcm16(
  pcm: Int16Array,
  sampleRate: number,
  winMs = 40,
  hopMs = 40
): number[] {
  const win = Math.max(1, Math.round((winMs / 1000) * sampleRate));
  const hop = Math.max(1, Math.round((hopMs / 1000) * sampleRate));
  const out: number[] = [];
  let maxRms = 1e-6;

  // Primero calculamos RMS crudo por ventana (para normalizar luego de forma robusta)
  for (let start = 0; start + win <= pcm.length; start += hop) {
    let sum = 0;
    for (let i = 0; i < win; i++) {
      const v = pcm[start + i] / 32768; // -1..1
      sum += v * v;
    }
    const rms = Math.sqrt(sum / win);
    out.push(rms);
    if (rms > maxRms) maxRms = rms;
  }

  // Normalización suave (ganancia máx 3x, clamp 0..1)
  const norm = Math.max(maxRms, 0.08);
  return out.map((r) => Math.min(1, (r / norm) * 1.5));
}

/** Convierte buffer WAV a una envolvente de niveles [0..1] cada ~winMs */
function levelsFromWav(wav: Buffer, winMs = 40): { levels: number[]; winMs: number } {
  const { pcm, sampleRate } = parseWavPcm16(wav);
  const levels = rmsLevelsFromPcm16(pcm, sampleRate, winMs, winMs);
  return { levels, winMs };
}


/** Convierte a WAV PCM16 mono 16k con ffmpeg (robusto para WebM/Ogg) */
async function toWavPcm16(buf: Buffer, mime = "audio/webm"): Promise<Buffer> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "stt-"));
  const inExt = mime.includes("ogg") ? "ogg" : mime.includes("webm") ? "webm" : "wav";
  const inPath = path.join(tmp, `in.${inExt}`);
  const outPath = path.join(tmp, `out.wav`);
  await fsp.writeFile(inPath, buf);

  await new Promise<void>((resolve, reject) => {
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

/** ======= STT sessions (buffer de audio por conexión) ======= */
type SttBuf = { chunks: Buffer[]; mime: string; lang?: string };
const sttSessions = new Map<string, SttBuf>();

/** ======= Piper TTS → Buffer WAV ======= */
async function synthesizeWithPiper(text: string, voiceBase: string): Promise<Buffer> {
  const voicesDir = path.resolve(process.cwd(), "voices");
  const model = path.join(voicesDir, `${voiceBase}.onnx`);
  const config = path.join(voicesDir, `${voiceBase}.onnx.json`);

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const child = spawn("piper", ["--model", model, "--config", config, "--output_file", "-"], {
      stdio: ["pipe", "pipe", "inherit"],
    });

    child.stdin.write(text);
    child.stdin.end();

    child.stdout.on("data", (c) => chunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`Piper exited with code ${code}`));
    });
  });
}

/** ======= Transcripción con Vosk (microservicio Python) =======
 * Envía WAV (16k mono) por multipart/form-data a /transcribe y devuelve texto
 */
const STT_HTTP_URL = process.env.STT_HTTP_URL || "http://127.0.0.1:9000/transcribe";

async function transcribeOnce(wavBuf: Buffer): Promise<string> {
  // Buffer -> Uint8Array (sin copia) para cumplir tipos de formdata-node
  const u8 = new Uint8Array(wavBuf.buffer, wavBuf.byteOffset, wavBuf.byteLength);

  const fd = new FormData();
  // 'audio/wav' porque ya convertimos a PCM16 mono 16k
  fd.append("file", new NodeFile([u8], "input.wav", { type: "audio/wav" }));

  const res = await fetch(STT_HTTP_URL, { method: "POST", body: fd as any, headers: (fd as any).headers });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`STT HTTP ${res.status}: ${txt || res.statusText}`);
  }
  const out = (await res.json()) as { text?: string };
  return (out?.text || "").trim();
}

/** ======= WS chat ======= */
app.get("/api/chat/ws", { websocket: true }, (conn) => {
  conn.socket.on("message", async (raw: any) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const turnId: string = msg.turnId ?? randomUUID();
    const replyBase = { v: 1 as const, turnId, replyTo: msg.msgId, t: Date.now() };

    switch (msg.type) {
      /* ======= STT: iniciar sesión ======= */
      case "stt_start": {
        const sessionId: string = msg?.data?.sessionId;
        const lang: string | undefined = msg?.data?.lang;
        const mime: string = msg?.data?.mime || "audio/webm";
        if (!sessionId) return;

        sttSessions.set(sessionId, { chunks: [], mime, lang });
        conn.socket.send(
          JSON.stringify({
            ...replyBase,
            type: "stt_ack",
            msgId: randomUUID(),
            data: { sessionId },
          })
        );
        return;
      }

      /* ======= STT: recibir trozos base64 ======= */
      case "stt_audio": {
        const { sessionId, b64 } = msg.data || {};
        const s = sttSessions.get(sessionId);
        if (!s || !b64) return;
        try {
          s.chunks.push(Buffer.from(b64, "base64"));
        } catch (e: any) {
          conn.socket.send(
            JSON.stringify({
              ...replyBase,
              type: "stt_error",
              msgId: randomUUID(),
              data: { sessionId, message: e?.message ?? "Malformed audio chunk" },
            })
          );
        }
        return;
      }

      /* ======= STT: finalizar, transcribir y responder ======= */
      case "stt_end": {
        const { sessionId } = msg.data || {};
        const s = sttSessions.get(sessionId);
        if (!s) return;

        try {
          const full = Buffer.concat(s.chunks);
          // Convertimos SIEMPRE a WAV 16k mono
          const wavBuf = await toWavPcm16(full, s.mime);
          const text = await transcribeOnce(wavBuf); // 👈 ahora Vosk microservicio
          conn.socket.send(
            JSON.stringify({
              ...replyBase,
              type: "stt_result",
              msgId: randomUUID(),
              data: { sessionId, text },
            })
          );
        } catch (e: any) {
          conn.socket.send(
            JSON.stringify({
              ...replyBase,
              type: "stt_error",
              msgId: randomUUID(),
              data: { sessionId, message: e?.message ?? "Transcription failed" },
            })
          );
        } finally {
          sttSessions.delete(sessionId);
        }
        return;
      }

      /* ======= CHAT normal (tu flujo existente) ======= */
      case "user_text": {
        const userText: string = msg.data?.text ?? "";
        const wantTTS: boolean = !!msg.data?.tts;
        const voiceBase: string = msg.data?.voice || "en_US-ryan-high";

        // Persona
        const persona = [
          "You are Taylor Rivera, a panelist persona.",
          "Traits: critical thinker; detail-oriented investigator; rights-driven advocate; ethically uncompromising; skeptical of hype; patient educator; community-minded collaborator.",
          "Tone: calm, precise, rights-focused. Challenge hype, explain trade-offs, prefer concrete examples, avoid sensationalism.",
        ].join(" ");

        // Rails
        const rails = [
          "Be concise by default: 2–4 short sentences. If the user explicitly asks for more detail, add 1–2 extra sentences.",
          "Use provided CONTEXT when relevant and cite with [ctx:n] where n matches the numbering in the CONTEXT.",
          "Do not fabricate sources. Only use [ctx:n] for facts that come from the CONTEXT. If unsure or missing info, say so and ask at most one clarifying question.",
          "Respond in the user's language when possible.",
        ].join(" ");

        const memorySystem = buildMemorySystem(conn.socket);

        // RAG
        let ctxBlock = "";
        let ctxMeta: Array<{ n: number; id: string; source: string; text: string }> = [];
        if (knowledgeIndex.length > 0 && userText.trim().length > 0) {
          try {
            const qEmb = await createEmbedding(userText);
            const hits = topK(qEmb, knowledgeIndex, 6);
            ctxBlock = hits.map((h, i) => `[ctx:${i + 1}] (${h.source}) ${h.text}`).join("\n\n");
            ctxMeta = hits.map((h, i) => ({ n: i + 1, id: h.id, source: h.source, text: h.text }));
          } catch (e: any) {
            app.log.warn(`RAG: fallo en recuperación (${e?.message ?? e})`);
          }
        }

        if (ctxMeta.length) {
          conn.socket.send(
            JSON.stringify({
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
            })
          );
        }

        const messages = [
          { role: "system" as const, content: persona },
          { role: "system" as const, content: rails },
          ...(memorySystem ? [{ role: "system" as const, content: memorySystem }] : []),
          ...(ctxBlock ? [{ role: "system" as const, content: `CONTEXT:\n${ctxBlock}` }] : []),
          { role: "user" as const, content: userText },
        ];

        // Streaming + chunker + TTS
        const chunker = new SentenceChunker({ gapMs: 380 });
        let tokenSeq = 0;
        let sentenceIndex = 0;
        const assistantParts: string[] = [];

        pushMemory(conn.socket, { role: "user", text: userText });

        try {
          for await (const delta of streamChatCompletion(messages)) {
            conn.socket.send(
              JSON.stringify({
                ...replyBase,
                type: "llm_token",
                msgId: randomUUID(),
                data: { text: delta, seq: tokenSeq++ },
              })
            );

            const sentences = chunker.push(delta);
            for (const s of sentences) {
              assistantParts.push(s);

              conn.socket.send(
                JSON.stringify({
                  ...replyBase,
                  type: "sentence",
                  msgId: randomUUID(),
                  data: { text: s, index: sentenceIndex },
                })
              );

              // Dentro del for de sentences (y también para el tail)
              if (wantTTS) {
                (async () => {
                  try {
                    const wav = await synthesizeWithPiper(s, voiceBase);

                    // 👇 NUEVO: calcula niveles por ~40ms
                    const { levels, winMs } = levelsFromWav(wav, 40);
                    // 1) informa que empieza TTS de esta oración (opcional)
                    conn.socket.send(JSON.stringify({
                      ...replyBase,
                      type: "tts_levels",
                      msgId: randomUUID(),
                      data: {
                        sentenceIndex,
                        winMs,         // ej. 40
                        levels,        // array de floats [0..1]
                      },
                    }));

                    // 2) envía el audio
                    conn.socket.send(
                      JSON.stringify({
                        ...replyBase,
                        type: "tts_chunk",
                        msgId: randomUUID(),
                        data: {
                          sentenceIndex,
                          mime: "audio/wav",
                          audioB64: wav.toString("base64"),
                        },
                      })
                    );
                  } catch (err: any) {
                    conn.socket.send(
                      JSON.stringify({
                        ...replyBase,
                        type: "tts_error",
                        msgId: randomUUID(),
                        data: { sentenceIndex, message: err?.message ?? "Piper failed" },
                      })
                    );
                  }
                })();
              }


              sentenceIndex++;
            }
          }

          const tail = chunker.flush();
          if (tail) {
            assistantParts.push(tail);

            conn.socket.send(
              JSON.stringify({
                ...replyBase,
                type: "sentence",
                msgId: randomUUID(),
                data: { text: tail, index: sentenceIndex },
              })
            );

            // Dentro del for de sentences (y también para el tail)
          if (wantTTS) {
            (async () => {
              try {
                const wav = await synthesizeWithPiper(tail, voiceBase);

                // 👇 NUEVO: calcula niveles por ~40ms
                const { levels, winMs } = levelsFromWav(wav, 40);
                console.log(levels);

                // 1) informa que empieza TTS de esta oración (opcional)
                conn.socket.send(JSON.stringify({
                  ...replyBase,
                  type: "tts_levels",
                  msgId: randomUUID(),
                  data: {
                    sentenceIndex,
                    winMs,         // ej. 40
                    levels,        // array de floats [0..1]
                  },
                }));

                // 2) envía el audio
                conn.socket.send(
                  JSON.stringify({
                    ...replyBase,
                    type: "tts_chunk",
                    msgId: randomUUID(),
                    data: {
                      sentenceIndex,
                      mime: "audio/wav",
                      audioB64: wav.toString("base64"),
                    },
                  })
                );
              } catch (err: any) {
                conn.socket.send(
                  JSON.stringify({
                    ...replyBase,
                    type: "tts_error",
                    msgId: randomUUID(),
                    data: { sentenceIndex, message: err?.message ?? "Piper failed" },
                  })
                );
              }
            })();
          }

          }

          conn.socket.send(JSON.stringify({ ...replyBase, type: "done", msgId: randomUUID(), data: {} }));

          const assistantFull = assistantParts.join(" ").trim();
          if (assistantFull) pushMemory(conn.socket, { role: "assistant", text: assistantFull });
        } catch (e: any) {
          app.log.error(e);
          conn.socket.send(
            JSON.stringify({
              ...replyBase,
              type: "error",
              msgId: randomUUID(),
              data: { code: "OPENAI_ERROR", message: e?.message ?? "OpenAI call failed" },
            })
          );
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
