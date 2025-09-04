import WebSocket from "ws";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
export class SttRealtimeSession {
    constructor(apiKey, sendToClient, opts = {}) {
        this.apiKey = apiKey;
        this.sendToClient = sendToClient;
        this.opts = opts;
        this.oaiReady = false;
        this.currentTurnAccum = "";
        this.sessionIdStr = "";
        // Guard state (server-visible)
        this.bytesSinceCommit = 0;
        this.minCommitBytes = 0;
        this.gotPcmSinceLastCommit = false;
        this.commitInFlight = false; // <- NEW: prevents double-commit during VAD races
    }
    startPartialTimer() {
        if (this.partialTimer)
            return;
        const every = this.opts.partialCommitMs ?? 600;
        this.partialTimer = setInterval(() => this.commitIfReady(), every);
    }
    stopPartialTimer() {
        try {
            if (this.partialTimer)
                clearInterval(this.partialTimer);
        }
        catch { }
        this.partialTimer = undefined;
    }
    /** Only commit when fresh PCM >= threshold and no commit is in flight */
    commitIfReady() {
        if (!this.oaiReady)
            return;
        if (this.commitInFlight)
            return; // wait for server ACK
        if (!this.gotPcmSinceLastCommit)
            return; // nothing new
        if (this.bytesSinceCommit < this.minCommitBytes)
            return; // < threshold
        try {
            this.commitInFlight = true;
            this.oai?.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
            // Counters reset ONLY after server ACK (completed transcription)
        }
        catch {
            this.commitInFlight = false; // allow retry next tick
        }
    }
    start(sessionId) {
        this.sessionIdStr = sessionId;
        const realtimeModel = this.opts.realtimeModel || "gpt-4o-realtime-preview";
        const sttModel = this.opts.sttModel || "gpt-4o-mini-transcribe";
        const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(realtimeModel)}`;
        // Safer default: 200ms (API minimum is 100ms)
        const minCommitMs = Math.max(this.opts.minCommitMs ?? 200, 100);
        this.minCommitBytes = minCommitMs * SttRealtimeSession.PCM_BYTES_PER_MS;
        this.oai = new WebSocket(url, {
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                "OpenAI-Beta": "realtime=v1",
            },
        });
        this.oai.on("open", () => {
            const language = this.opts.language || "en";
            const silenceMs = this.opts.silenceMs ?? 350;
            this.oai.send(JSON.stringify({
                type: "session.update",
                session: {
                    input_audio_format: "pcm16", // MUST be a string enum
                    input_audio_transcription: { model: sttModel, language },
                    turn_detection: { type: "server_vad", silence_duration_ms: silenceMs, prefix_padding_ms: 200 },
                },
            }));
            this.sendToClient({ type: "stt_ready", data: { sessionId } });
            this.oaiReady = true;
        });
        this.oai.on("message", (buf) => {
            try {
                const ev = JSON.parse(buf.toString());
                if (ev?.type === "input_audio_buffer.speech_started") {
                    // New speech turn: reset everything
                    this.currentTurnAccum = "";
                    this.bytesSinceCommit = 0;
                    this.gotPcmSinceLastCommit = false;
                    this.commitInFlight = false;
                    this.sendToClient({ type: "stt_vad_start", data: { sessionId: this.sessionIdStr } });
                }
                // Server ACK for a commit: completed transcription of the committed buffer
                if (ev?.type === "conversation.item.input_audio_transcription.completed") {
                    const text = (ev?.transcript || ev?.text || "").trim();
                    // Sync our guards to the server-visible commit point
                    this.bytesSinceCommit = 0;
                    this.gotPcmSinceLastCommit = false;
                    this.commitInFlight = false; // allow next commit
                    if (text) {
                        this.currentTurnAccum += (this.currentTurnAccum ? " " : "") + text;
                        this.sendToClient({
                            type: "stt_transcript_partial",
                            data: { text: this.currentTurnAccum, sessionId: this.sessionIdStr }
                        });
                    }
                }
                // Do NOT commit here; server VAD typically already did it
                if (ev?.type === "input_audio_buffer.speech_stopped") {
                    this.stopPartialTimer();
                    if (this.currentTurnAccum) {
                        this.sendToClient({
                            type: "stt_transcript_final",
                            data: { text: this.currentTurnAccum, sessionId: this.sessionIdStr }
                        });
                        this.currentTurnAccum = "";
                    }
                    // Reset guards for next turn
                    this.bytesSinceCommit = 0;
                    this.gotPcmSinceLastCommit = false;
                    this.commitInFlight = false;
                    this.sendToClient({ type: "stt_vad_stop", data: { sessionId: this.sessionIdStr } });
                }
                if (ev?.type === "error") {
                    this.sendToClient({
                        type: "stt_error",
                        data: { message: ev?.error?.message || "OpenAI realtime error" },
                    });
                    // also unblock commit attempts so we can recover
                    this.commitInFlight = false;
                }
            }
            catch {
                // ignore parse errors
            }
        });
        // Transcoding: webm/opus -> pcm s16le 16k mono
        this.opusIn = new PassThrough();
        this.pcmOut = new PassThrough();
        this.ff = spawn("ffmpeg", [
            "-hide_banner", "-loglevel", "error",
            "-f", "webm", "-i", "pipe:0",
            "-ac", "1", "-ar", "16000",
            "-f", "s16le", "pipe:1"
        ], { stdio: ["pipe", "pipe", "pipe"] });
        this.opusIn.pipe(this.ff.stdin);
        this.ff.stdout.pipe(this.pcmOut);
        this.pcmOut.on("data", (pcmChunk) => {
            if (!this.oaiReady)
                return;
            // Track fresh PCM since last server-acknowledged commit
            this.bytesSinceCommit += pcmChunk.length;
            this.gotPcmSinceLastCommit = true;
            this.oai?.send(JSON.stringify({
                type: "input_audio_buffer.append",
                audio: pcmChunk.toString("base64"),
            }));
            // Low-latency path: if threshold reached, try committing now
            this.commitIfReady();
        });
        this.ff.on("error", (e) => {
            this.sendToClient({ type: "stt_error", data: { message: "ffmpeg error: " + e.message } });
            this.commitInFlight = false;
        });
    }
    /** Browser sends webm/opus (base64) chunks */
    appendOpusBase64(b64) {
        if (!this.opusIn)
            return;
        this.startPartialTimer(); // start rolling commits once audio flows
        const buf = Buffer.from(b64, "base64");
        this.opusIn.write(buf);
    }
    /** Client indicates end of user turn */
    async stopTurn() {
        this.stopPartialTimer();
        try {
            this.opusIn?.end();
        }
        catch { }
        // No forced commit here — server VAD will have committed, or the last partial will do.
    }
    /** Full cleanup (when client WS closes) */
    close() {
        this.stopPartialTimer();
        try {
            this.opusIn?.destroy();
        }
        catch { }
        try {
            this.pcmOut?.destroy();
        }
        catch { }
        try {
            this.ff?.kill("SIGKILL");
        }
        catch { }
        try {
            this.oai?.close();
        }
        catch { }
    }
}
// 16kHz mono, s16le: 2 bytes/sample => 32,000 bytes/sec => 32 bytes/ms
SttRealtimeSession.PCM_BYTES_PER_MS = 32;
