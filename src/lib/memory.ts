import { embed } from "./ollama";
import { listWorkspace, readWorkspaceFile } from "./workspace";

export const EMBED_MODEL_PREFIX = "nomic-embed-text";

interface Chunk {
  path: string;
  text: string;
  vector?: number[];
}

// Vectors are cached in memory only (never written to disk), keyed by chunk text.
const vectorCache = new Map<string, number[]>();

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function chunkText(path: string, text: string): Chunk[] {
  return text
    .split(/\n\s*\n|\n(?=- )/)
    .map((part) => part.trim())
    .filter((part) => part.length > 8)
    .map((part) => ({ path, text: part.slice(0, 600) }));
}

// Meaning-based recall over the agent workspace using a local Ollama embedding model.
export async function semanticSearch(baseUrl: string, model: string, query: string, limit = 6): Promise<string[]> {
  const files = await listWorkspace();
  const chunks: Chunk[] = [];
  for (const file of files) {
    if (file.size > 200_000) continue;
    const text = await readWorkspaceFile(file.path).catch(() => "");
    chunks.push(...chunkText(file.path, text));
  }
  const missing = chunks.filter((chunk) => !vectorCache.has(chunk.text));
  for (let i = 0; i < missing.length; i += 32) {
    const batch = missing.slice(i, i + 32);
    const vectors = await embed(baseUrl, model, batch.map((chunk) => chunk.text));
    batch.forEach((chunk, index) => vectorCache.set(chunk.text, vectors[index]));
  }
  const [queryVector] = await embed(baseUrl, model, [query]);
  if (!queryVector) return [];
  const scored = chunks
    .map((chunk) => ({ chunk, score: cosine(queryVector, vectorCache.get(chunk.text) ?? []) }))
    .filter((item) => item.score > 0.45)
    .sort((a, b) => b.score - a.score);
  // Keep only results close to the best match so weak neighbours don't add noise.
  return scored
    .filter((item) => item.score >= scored[0].score - 0.08)
    .slice(0, limit)
    .map(({ chunk }) => `${chunk.path}: ${chunk.text.replace(/\s+/g, " ")}`);
}
