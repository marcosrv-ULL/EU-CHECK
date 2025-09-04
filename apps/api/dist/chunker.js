export class SentenceChunker {
    constructor(opts = {}) {
        this.buf = "";
        this.lastTs = 0;
        this.gapMs = opts.gapMs ?? 380;
        this.re = opts.regex ?? /([\.!?…]+)(\s+|$)/;
    }
    push(delta) {
        const out = [];
        const now = Date.now();
        const gap = this.lastTs ? now - this.lastTs : 0;
        this.lastTs = now;
        this.buf += delta;
        while (true) {
            const m = this.buf.match(this.re);
            if (!m)
                break;
            const cutIdx = (m.index ?? 0) + m[0].length;
            const sentence = this.buf.slice(0, cutIdx).trim();
            this.buf = this.buf.slice(cutIdx);
            if (sentence)
                out.push(sentence);
        }
        if (gap > this.gapMs && this.buf.trim().length > 0) {
            out.push(this.buf.trim());
            this.buf = "";
        }
        return out;
    }
    flush() {
        const s = this.buf.trim();
        this.buf = "";
        return s || null;
    }
}
