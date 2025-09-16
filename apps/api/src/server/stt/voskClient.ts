import { FormData, File as NodeFile } from "formdata-node";
import { fetch } from "undici";

const STT_HTTP_URL = process.env.STT_HTTP_URL || "http://127.0.0.1:9000/transcribe";

/** Envía WAV (16k mono) por multipart/form-data a /transcribe y devuelve texto */
export async function transcribeOnce(wavBuf: Buffer): Promise<string> {
  const u8 = new Uint8Array(wavBuf.buffer, wavBuf.byteOffset, wavBuf.byteLength);

  const fd = new FormData();
  fd.append("file", new NodeFile([u8], "input.wav", { type: "audio/wav" }));

  const res = await fetch(STT_HTTP_URL, { method: "POST", body: fd as any, headers: (fd as any).headers });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`STT HTTP ${res.status}: ${txt || res.statusText}`);
  }
  const out = (await res.json()) as { text?: string };
  return (out?.text || "").trim();
}
