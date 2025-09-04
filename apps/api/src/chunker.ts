// apps/api/src/chunker.ts
export interface ChunkerOptions {
    gapMs?: number;
    regex?: RegExp;
  }
  
  export class SentenceChunker {
    private buf = "";
    private lastTs = 0;
    private readonly gapMs: number;
    private readonly re: RegExp;
  
    constructor(opts: ChunkerOptions = {}) {
      this.gapMs = opts.gapMs ?? 380;
      this.re = opts.regex ?? /([\.!?…]+)(\s+|$)/;
    }
  
    push(delta: string): string[] {
      const out: string[] = [];
      const now = Date.now();
      const gap = this.lastTs ? now - this.lastTs : 0;
      this.lastTs = now;
  
      this.buf += delta;
  
      while (true) {
        const m = this.buf.match(this.re);
        if (!m) break;
        const cutIdx = (m.index ?? 0) + m[0].length;
        const sentence = this.buf.slice(0, cutIdx).trim();
        this.buf = this.buf.slice(cutIdx);
        if (sentence) out.push(sentence);
      }
  
      if (gap > this.gapMs && this.buf.trim().length > 0) {
        out.push(this.buf.trim());
        this.buf = "";
      }
  
      return out;
    }
  
    flush(): string | null {
      const s = this.buf.trim();
      this.buf = "";
      return s || null;
    }
  }
  