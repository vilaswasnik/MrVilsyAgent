// Reasoning models (Qwen3, DeepSeek-R1) may emit <think>...</think> inside the reply.
// It must never be shown, stored, or written to a memory file.
const THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi;
const OPEN = "<think>";
const CLOSE = "</think>";

export function stripThink(text: string): string {
  let out = text.replace(THINK_BLOCK, "");
  // An unterminated block (cut off mid-thought) is dropped as well.
  const open = out.toLowerCase().indexOf(OPEN);
  if (open !== -1) out = out.slice(0, open);
  return out.replace(/<\/think>/gi, "").replace(/^\s+/, "");
}

// Incremental version for streaming: feed chunks, get only the visible text back.
export class ThinkFilter {
  private buffer = "";
  private inThink = false;

  push(chunk: string): string {
    this.buffer += chunk;
    let visible = "";
    for (;;) {
      const lower = this.buffer.toLowerCase();
      const marker = this.inThink ? CLOSE : OPEN;
      const at = lower.indexOf(marker);
      if (at !== -1) {
        if (!this.inThink) visible += this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + marker.length);
        this.inThink = !this.inThink;
        continue;
      }
      // Keep a possible partial tag at the end of the buffer for the next chunk.
      let keep = 0;
      for (let n = Math.min(marker.length - 1, lower.length); n > 0; n--) {
        if (marker.startsWith(lower.slice(lower.length - n))) {
          keep = n;
          break;
        }
      }
      if (!this.inThink) visible += this.buffer.slice(0, this.buffer.length - keep);
      this.buffer = this.buffer.slice(this.buffer.length - keep);
      return visible;
    }
  }

  // Text still buffered when the stream ends (a dangling partial tag in normal text).
  flush(): string {
    const rest = this.inThink ? "" : this.buffer;
    this.buffer = "";
    this.inThink = false;
    return rest;
  }
}
