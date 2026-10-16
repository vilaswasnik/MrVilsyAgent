import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  files: [] as { path: string; name: string; size: number; modified_ms: number }[],
  text: {} as Record<string, string>,
  index: "",
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "docs_scan":
        return store.files;
      case "docs_extract":
        return store.text[args.path as string] ?? "";
      case "docs_index_load":
        return store.index;
      case "docs_index_save":
        store.index = args.json as string;
        return null;
      default:
        throw new Error(`unexpected invoke ${cmd}`);
    }
  }),
}));

import { chunkDocument, formatHits, indexDocuments, loadIndex, rankEntries, resetIndexCache, searchDocuments } from "./docs";

// Deterministic bag-of-words embedder so retrieval can be tested without Ollama.
function fakeVector(text: string): number[] {
  const v = new Array(64).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 0;
    for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) % 64;
    v[h] += 1;
  }
  return v;
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { input: string[] };
    return new Response(JSON.stringify({ embeddings: body.input.map((t) => fakeVector(t.replace(/^search_(document|query): /, ""))) }), { status: 200 });
  }));
}

const I797 = "Form I-797 Notice of Action. Receipt number ABC1234567890. Beneficiary: Jane Doe. Valid from 10/01/2024 to 09/30/2027. Classification: H-1B.";

describe("chunking", () => {
  it("makes ~800-token chunks that overlap by ~100 tokens", () => {
    const text = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const chunks = chunkDocument(text);
    expect(chunks.length).toBeGreaterThan(2);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(3200);
    // The tail of one chunk reappears at the start of the next.
    const tail = chunks[0].slice(-120);
    expect(chunks[1].includes(tail.slice(40, 100))).toBe(true);
  });

  it("returns nothing for empty text", () => {
    expect(chunkDocument("  \n ")).toEqual([]);
  });
});

describe("document Q&A retrieval", () => {
  beforeEach(() => {
    store.files = [
      { path: "C:\\Docs\\resume\\I-797.docx", name: "I-797.docx", size: 100, modified_ms: Date.parse("2024-10-05T00:00:00Z") },
      { path: "C:\\Docs\\resume\\resume.txt", name: "resume.txt", size: 100, modified_ms: Date.parse("2025-01-01T00:00:00Z") },
    ];
    store.text = {
      "C:\\Docs\\resume\\I-797.docx": I797,
      "C:\\Docs\\resume\\resume.txt": "Jane Doe. Senior data engineer. Skills: Python, SQL, Spark, Airflow. Experience: 8 years in analytics.",
    };
    store.index = "";
    resetIndexCache();
    installFetch();
  });

  async function build() {
    const result = await indexDocuments({
      baseUrl: "http://localhost:11434",
      embedModel: "nomic-embed-text",
      chatModel: "",
      summarizeLong: false,
      numCtx: 8192,
      signal: new AbortController().signal,
      onProgress: () => {},
    });
    expect(result.indexed).toBe(2);
  }

  it("answers the I-797 validity question with the file as source", async () => {
    await build();
    const out = await searchDocuments("http://localhost:11434", "nomic-embed-text", "what does my I-797 document say my validity is");
    expect(out).toContain("Source: I-797.docx");
    expect(out).toContain("Valid from 10/01/2024 to 09/30/2027");
    expect(out).toContain("file dated 2024-10-05");
  });

  it("finds an exact identifier by keyword even without an embedding model", async () => {
    await build();
    const out = await searchDocuments("http://localhost:11434", undefined, "receipt number ABC1234567890");
    expect(out).toContain("I-797.docx");
  });

  it("says it cannot find an answer that is not in the documents", async () => {
    await build();
    const out = await searchDocuments("http://localhost:11434", "nomic-embed-text", "what is my passport expiration date");
    expect(out).toMatch(/cannot find it/);
    expect(out).toMatch(/Do not guess/);
    expect(out).not.toContain("Source:");
  });

  it("skips unchanged files and drops files that disappeared", async () => {
    await build();
    store.files = store.files.slice(0, 1);
    const result = await indexDocuments({ baseUrl: "http://localhost:11434", embedModel: "nomic-embed-text", chatModel: "", summarizeLong: false, numCtx: 8192, signal: new AbortController().signal, onProgress: () => {} });
    expect(result).toMatchObject({ indexed: 0, skipped: 1, removed: 1 });
    expect(Object.keys((await loadIndex()).files)).toEqual(["C:\\Docs\\resume\\I-797.docx"]);
  });

  it("flags files with no extractable text instead of indexing nothing silently", async () => {
    store.text["C:\\Docs\\resume\\resume.txt"] = "";
    const result = await indexDocuments({ baseUrl: "http://localhost:11434", embedModel: "nomic-embed-text", chatModel: "", summarizeLong: false, numCtx: 8192, signal: new AbortController().signal, onProgress: () => {} });
    expect(result.failed).toBe(1);
    expect((await loadIndex()).files["C:\\Docs\\resume\\resume.txt"].error).toMatch(/OCR/);
  });

  it("tells the agent when nothing is indexed", async () => {
    expect(await searchDocuments("http://localhost:11434", "nomic-embed-text", "anything")).toMatch(/No documents are indexed/);
  });

  it("includes section summaries of long documents as citable passages", () => {
    const index = {
      version: 1 as const,
      embedModel: "m",
      files: {
        a: {
          path: "a", name: "book.pdf", size: 1, modifiedMs: 0, indexedAt: 0, chunkCount: 20,
          entries: [{ kind: "summary" as const, n: 1, to: 5, text: "Chapter one covers the visa timeline and deadlines.", vector: [] }],
        },
      },
    };
    const hits = rankEntries(index, "visa timeline deadlines", null);
    expect(formatHits(hits)).toContain("summary of chunks 1-5 of 20");
    expect(formatHits(hits)).toContain("Source: book.pdf");
  });
});
