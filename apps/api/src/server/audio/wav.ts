import { spawn } from "node:child_process";
import path from "node:path";
import fsp from "node:fs/promises";
import os from "node:os";

export function parseWavPcm16(wav: Buffer): { pcm: Int16Array; sampleRate: number } {
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a WAV file");
  }
  let offset = 12;
  let fmtChunkOffset = -1;
  let dataChunkOffset = -1;
  let dataChunkLen = 0;
  let audioFormat = 1;
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

  const sampleCount = (dataChunkLen / 2) | 0;
  const pcmAll = new Int16Array(wav.buffer, wav.byteOffset + dataChunkOffset, sampleCount);

  if (numChannels === 1) {
    return { pcm: new Int16Array(pcmAll), sampleRate };
  } else if (numChannels === 2) {
    const mono = new Int16Array(sampleCount / 2);
    for (let i = 0, j = 0; j < mono.length; i += 2, j++) {
      mono[j] = ((pcmAll[i] + pcmAll[i + 1]) / 2) | 0;
    }
    return { pcm: mono, sampleRate };
  } else {
    throw new Error(`Unsupported channels: ${numChannels}`);
  }
}

export function rmsLevelsFromPcm16(
  pcm: Int16Array,
  sampleRate: number,
  winMs = 40,
  hopMs = 40
): number[] {
  const win = Math.max(1, Math.round((winMs / 1000) * sampleRate));
  const hop = Math.max(1, Math.round((hopMs / 1000) * sampleRate));
  const out: number[] = [];
  let maxRms = 1e-6;

  for (let start = 0; start + win <= pcm.length; start += hop) {
    let sum = 0;
    for (let i = 0; i < win; i++) {
      const v = pcm[start + i] / 32768;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / win);
    out.push(rms);
    if (rms > maxRms) maxRms = rms;
  }

  const norm = Math.max(maxRms, 0.08);
  return out.map((r) => Math.min(1, (r / norm) * 1.5));
}

export function levelsFromWav(wav: Buffer, winMs = 40): { levels: number[]; winMs: number } {
  const { pcm, sampleRate } = parseWavPcm16(wav);
  const levels = rmsLevelsFromPcm16(pcm, sampleRate, winMs, winMs);
  return { levels, winMs };
}

export async function toWavPcm16(buf: Buffer, mime = "audio/webm"): Promise<Buffer> {
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
