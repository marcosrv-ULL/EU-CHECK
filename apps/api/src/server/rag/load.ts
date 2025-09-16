import type { FastifyBaseLogger } from "fastify";
import type { DocChunk } from "@/services/knowledge";
import { indexDir } from "@/services/knowledge";

export async function loadKnowledge(
  knowledgeDir: string,
  log: FastifyBaseLogger
): Promise<(DocChunk & { rank?: number })[]> {
  try {
    const idx = await indexDir(knowledgeDir);
    log.info(`RAG: indexados ${idx.length} fragmentos desde ${knowledgeDir}`);
    return idx;
  } catch (e: any) {
    log.warn(`RAG: no se pudo cargar carpeta ${knowledgeDir} (${e?.message ?? e})`);
    return [];
  }
}
