import { spawn } from "node:child_process";
import path from "node:path";

export async function synthesizeWithPiper(text: string, voiceBase: string): Promise<Buffer> {
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
