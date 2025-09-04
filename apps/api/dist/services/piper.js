// apps/api/src/services/piper.ts
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
/**
 * Sintetiza `text` con Piper y devuelve un Buffer WAV.
 * Por defecto usa la voz inglesa "en_US-ryan-high" ubicada en ../../voices (respecto a este archivo).
 */
export async function synthesizeWithPiper(text, opts = {}) {
    const logger = opts.logger ?? console;
    // __dirname robusto en ESM
    const HERE = typeof __dirname !== "undefined"
        ? __dirname
        : path.dirname(fileURLToPath(import.meta.url));
    // Carpeta voices: por defecto ../../voices (junto al proyecto apps/api/voices)
    const voicesDir = opts.voicesDir ?? path.resolve(HERE, "../../voices");
    const voiceBase = opts.voiceBase ?? "en_US-ryan-high";
    const model = opts.modelPath ?? path.join(voicesDir, `${voiceBase}.onnx`);
    const config = opts.configPath ?? path.join(voicesDir, `${voiceBase}.onnx.json`);
    // Valida que existan los ficheros
    for (const f of [model, config]) {
        try {
            await fs.access(f);
        }
        catch {
            throw new Error(`[piper] No se encontró el archivo de voz: ${f}`);
        }
    }
    const args = [
        "--model", model,
        "--config", config,
        "--output_file", "-",
        "--length-scale", String(opts.lengthScale ?? 1.08),
        "--noise-scale", String(opts.noiseScale ?? 0.33),
        "--noise-w-scale", String(opts.noiseWScale ?? 0.70),
        "--sentence-silence", String(opts.sentenceSilence ?? 0.18),
    ];
    const piperBin = opts.piperBin ?? process.env.PIPER_BIN ?? "piper";
    const timeoutMs = opts.timeoutMs ?? 20000;
    if (opts.debug) {
        logger.info?.(`[piper] spawn: ${piperBin} ${args.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
        logger.info?.(`[piper] voicesDir=${voicesDir}`);
    }
    return new Promise((resolve, reject) => {
        const chunks = [];
        let stderrBuf = "";
        let killed = false;
        const child = spawn(piperBin, args, { stdio: ["pipe", "pipe", "pipe"] });
        const timer = setTimeout(() => {
            killed = true;
            child.kill("SIGKILL");
        }, timeoutMs);
        child.on("error", (err) => {
            clearTimeout(timer);
            reject(new Error(`[piper] fallo al lanzar el proceso: ${err.message}`));
        });
        child.stdout.on("data", (c) => chunks.push(c));
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (d) => {
            stderrBuf += d;
            if (opts.debug)
                logger.info?.(`[piper][stderr] ${d.trim()}`);
        });
        child.on("close", (code, signal) => {
            clearTimeout(timer);
            if (!killed && code === 0) {
                resolve(Buffer.concat(chunks));
            }
            else {
                reject(new Error(`[piper] terminado con code=${code} signal=${signal}\n${stderrBuf.trim()}`));
            }
        });
        // Escribimos el texto a sintetizar
        try {
            child.stdin.write(text);
            child.stdin.end();
        }
        catch (e) {
            clearTimeout(timer);
            reject(new Error(`[piper] error escribiendo stdin: ${e?.message || e}`));
        }
    });
}
