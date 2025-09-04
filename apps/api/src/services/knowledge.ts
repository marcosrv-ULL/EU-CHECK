// services/knowledge.ts
import fs from "node:fs/promises";
import path from "node:path";
import {createEmbedding} from "./openai";

export type DocChunk = { id: string; text: string; embedding: number[]; source: string };

export async function indexDir(dir: string): Promise<DocChunk[]> {
  const files = await fs.readdir(dir);
  const chunks: DocChunk[] = [];

  for (const f of files) {
    const full = path.join(dir, f);
    const txt = await fs.readFile(full, "utf8");
    // Trocea por párrafos/secciones
    const parts = txt.split(/\n\s*\n/g).filter((s) => s.trim().length > 0);

    for (let i = 0; i < parts.length; i++) {
      const slice = parts[i].slice(0, 1200); // ~límite aproximado
      const embedding = await createEmbedding(slice);
      chunks.push({ id: `${f}#${i}`, text: slice, embedding, source: f });
    }
  }

  return chunks;
}

export function topK(queryEmbed: number[], chunks: DocChunk[], k = 6) {
  const cos = (a: number[], b: number[]) => {
    let s = 0,
      na = 0,
      nb = 0;
    for (let i = 0; i < a.length; i++) {
      s += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return s / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
  };

  return chunks
    .map((c) => ({ c, score: cos(queryEmbed, c.embedding) }))
    .sort((x, y) => y.score - x.score)
    .slice(0, k)
    .map((x, i) => ({ ...x.c, rank: i + 1 }));
}
