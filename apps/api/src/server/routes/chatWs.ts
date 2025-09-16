import type { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";
import { SentenceChunker } from "@/chunker";
import { streamChatCompletion, createEmbedding } from "@/services/openai";
import type { DocChunk } from "@/services/knowledge";
import { topK } from "@/services/knowledge";

import { synthesizeWithPiper } from "@/server/tts/piper";
import { levelsFromWav, toWavPcm16 } from "@/server/audio/wav";
import { transcribeOnce } from "@/server/stt/voskClient";
import { sttSessions } from "@/server/stt/sessions";
import { pushMemory, buildMemorySystem } from "@/server/memory/sessionMemory";

type Deps = {
  knowledgeIndex: () => (DocChunk & { rank?: number })[];
};

export function registerChatWsRoute(app: FastifyInstance, deps: Deps) {
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
            const wavBuf = await toWavPcm16(full, s.mime);
            const text = await transcribeOnce(wavBuf);
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

        /* ======= CHAT normal ======= */
        case "user_text": {
          const userText: string = msg.data?.text ?? "";
          const wantTTS: boolean = !!msg.data?.tts;
          const voiceBase: string = msg.data?.voice || "en_US-ryan-high";

          const persona = [
            "You are Taylor Rivera, a panelist persona.",
            "Traits: critical thinker; detail-oriented investigator; rights-driven advocate; ethically uncompromising; skeptical of hype; patient educator; community-minded collaborator.",
            "Tone: calm, precise, rights-focused. Challenge hype, explain trade-offs, prefer concrete examples, avoid sensationalism.",
          ].join(" ");

          const rails = [
            "Be concise by default: 2–4 short sentences. If the user explicitly asks for more detail, add 1–2 extra sentences.",
            "Use provided CONTEXT when relevant and cite with [ctx:n] where n matches the numbering in the CONTEXT.",
            "Do not fabricate sources. Only use [ctx:n] for facts that come from the CONTEXT. If unsure or missing info, say so and ask at most one clarifying question.",
            "Respond in the user's language when possible.",
          ].join(" ");

          const memorySystem = buildMemorySystem(conn.socket);

          // RAG
          const knowledgeIndex = deps.knowledgeIndex();
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

                if (wantTTS) {
                  (async () => {
                    try {
                      const wav = await synthesizeWithPiper(s, voiceBase);
                      const { levels, winMs } = levelsFromWav(wav, 40);

                      conn.socket.send(JSON.stringify({
                        ...replyBase,
                        type: "tts_levels",
                        msgId: randomUUID(),
                        data: { sentenceIndex, winMs, levels },
                      }));

                      conn.socket.send(
                        JSON.stringify({
                          ...replyBase,
                          type: "tts_chunk",
                          msgId: randomUUID(),
                          data: { sentenceIndex, mime: "audio/wav", audioB64: wav.toString("base64") },
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

              if (wantTTS) {
                (async () => {
                  try {
                    const wav = await synthesizeWithPiper(tail, voiceBase);
                    const { levels, winMs } = levelsFromWav(wav, 40);

                    conn.socket.send(JSON.stringify({
                      ...replyBase,
                      type: "tts_levels",
                      msgId: randomUUID(),
                      data: { sentenceIndex, winMs, levels },
                    }));

                    conn.socket.send(
                      JSON.stringify({
                        ...replyBase,
                        type: "tts_chunk",
                        msgId: randomUUID(),
                        data: { sentenceIndex, mime: "audio/wav", audioB64: wav.toString("base64") },
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
}
