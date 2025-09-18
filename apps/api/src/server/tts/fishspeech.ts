import fetch from "node-fetch";

export async function synthesizeWithFishSpeech(
  text: string,
  opts: { base?: string } = {}
): Promise<Buffer> {
  const base = opts.base ?? "http://127.0.0.1:8080"; // adjust if running elsewhere

  // Tip: open the server UI at / to confirm the path; often it's /api/tts
  const res = await fetch(`${base}/api/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Fish-Speech supports emotion/tone markers in text:
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Fish-Speech HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}