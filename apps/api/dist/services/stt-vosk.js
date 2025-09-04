// apps/api/src/services/stt-vosk.ts
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import Vosk from "vosk";
import path from "node:path";
export class VoskRealtimeSTT {
    constructor(opts) {
        this.opts = opts;
        this.ready = false;
    }
    async init() {
        const sampleRate = this.opts.sampleRate ?? 16000;
        const mPath = path.resolve(this.opts.modelPath);
        Vosk.setLogLevel(0);
        this.model = new Vosk.Model(mPath);
        this.recognizer = new Vosk.Recognizer({ model: this.model, sampleRate });
        this.ready = true;
    }
    /**
     * Prepara el pipeline ffmpeg -> PCM -> recognizer
     * Devuelve callbacks para alimentar audio (webm/opus) y para cerrar.
     */
    attach(onPartial, onFinal) {
        if (!this.ready || !this.recognizer) {
            throw new Error("VoskRealtimeSTT: init() was not called");
        }
        const sampleRate = this.opts.sampleRate ?? 16000;
        // ffmpeg decodifica de Opus/WebM a PCM s16le 16kHz mono
        this.ff = spawn("ffmpeg", [
            "-hide_banner",
            "-loglevel", "error",
            "-fflags", "+discardcorrupt",
            "-i", "pipe:0",
            "-acodec", "pcm_s16le",
            "-ac", "1",
            "-ar", String(sampleRate),
            "-f", "s16le",
            "pipe:1",
        ], { stdio: ["pipe", "pipe", "pipe"] });
        this.pcmOut = new PassThrough();
        // Pipeamos la salida PCM al passthrough
        this.ff.stdout.pipe(this.pcmOut);
        this.ff.stderr.on("data", (d) => {
            // Log opcional de ffmpeg
            // console.error("[ffmpeg]", d.toString());
        });
        // Consumimos PCM y alimentamos a Vosk
        this.pcmOut.on("data", async (chunk) => {
            // Vosk espera Int16LE
            const ok = await this.recognizer.acceptWaveformAsync(chunk);
            if (ok) {
                const res = this.recognizer.result();
                if (res && res.text && res.text.trim()) {
                    onFinal(res.text.trim());
                }
            }
            else if (this.opts.enablePartials !== false) {
                const p = this.recognizer.partialResult();
                if (p && p.partial && p.partial.trim()) {
                    onPartial(p.partial.trim());
                }
            }
        });
        const feedOpus = (chunk) => {
            // Enviamos audio comprimido (webm/opus) hacia ffmpeg
            if (this.ff && this.ff.stdin.writable) {
                this.ff.stdin.write(chunk);
            }
        };
        const endStream = () => {
            if (this.ff) {
                this.ff.stdin.end();
            }
        };
        const destroy = () => {
            try {
                if (this.ff) {
                    this.ff.kill("SIGKILL");
                }
            }
            catch { }
            try {
                if (this.pcmOut) {
                    this.pcmOut.destroy();
                }
            }
            catch { }
            try {
                if (this.recognizer) {
                    this.recognizer.free();
                    this.recognizer = undefined;
                }
                if (this.model) {
                    this.model.free();
                    this.model = undefined;
                }
            }
            catch { }
        };
        return { feedOpus, endStream, destroy };
    }
}
