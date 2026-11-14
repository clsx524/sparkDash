// CSI sequences (colors, cursor moves, erase) and OSC (window titles).
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][A-Za-z0-9]/g;

export function stripAnsi(text) {
  return text.replace(ANSI_RE, "");
}

/** Split command output, treating carriage returns as progress-line redraws. */
export class LineSplitter {
  constructor() {
    this.buf = "";
    this.cr = false;
  }

  feed(chunk) {
    const out = [];
    for (const ch of stripAnsi(chunk)) {
      if (this.cr) {
        this.cr = false;
        if (ch === "\n") {
          out.push(this.buf);
          this.buf = "";
          continue;
        }
        this.buf = "";
      }
      if (ch === "\n") {
        out.push(this.buf);
        this.buf = "";
      } else if (ch === "\r") {
        this.cr = true;
      } else {
        this.buf += ch;
      }
    }
    return out;
  }

  get partial() {
    return this.buf;
  }

  flush() {
    const rest = this.buf;
    this.buf = "";
    this.cr = false;
    return rest;
  }
}
