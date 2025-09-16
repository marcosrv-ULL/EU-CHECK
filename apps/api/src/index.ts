// src/index.ts
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import path from "node:path";

import { registerChatWsRoute } from "@/server/routes/chatWs";
import { loadKnowledge } from "@/server/rag/load";

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(websocket);

app.get("/api/health", async () => ({ ok: true }));

// Carga inicial del índice RAG
const knowledgeDir = path.resolve(process.cwd(), "knowledge");
const knowledgeIndex = await loadKnowledge(knowledgeDir, app.log);

// Registra la ruta WS y le entrega una función para leer el índice
registerChatWsRoute(app, { knowledgeIndex: () => knowledgeIndex });

const port = Number(process.env.PORT || 3000);
app.listen({ port, host: "0.0.0.0" });
