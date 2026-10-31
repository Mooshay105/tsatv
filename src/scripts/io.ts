/**
 * Input/output used by scripts.
 *
 * Scripts never use process.stdout/stdin directly, making it possible to capture output
 * and provide input when testing.
 */

export interface ScriptIO {
  /** Write text to standard output. */
  stdout(text: string): void;
  /** Write text to standard error. */
  stderr(text: string): void;
  /** Read a line from standard input (without line ending). Returns "" at EOF. */
  readline(): Promise<string>;
  /** Raw standard input as a stream of bytes. */
  stdinStream(): AsyncIterable<Uint8Array>;
}

/** Line reader on top of a byte stream. */
class LineReader {
  private buffer = "";
  private iterator: AsyncIterator<Uint8Array> | null = null;
  private done = false;
  private readonly decoder = new TextDecoder();

  constructor(private readonly source: () => AsyncIterable<Uint8Array>) {}

  async readline(): Promise<string> {
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        return line.replace(/\r$/, "");
      }
      if (this.done) {
        const rest = this.buffer;
        this.buffer = "";
        return rest;
      }
      this.iterator ??= this.source()[Symbol.asyncIterator]();
      const next = await this.iterator.next();
      if (next.done) this.done = true;
      else this.buffer += this.decoder.decode(next.value, { stream: true });
    }
  }
}

/** IO connected to the process. */
export function processIO(): ScriptIO {
  const stdin = () => Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>;
  const reader = new LineReader(stdin);
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readline: () => reader.readline(),
    stdinStream: stdin,
  };
}

/** IO reading input from a string and capturing output (used by tests). */
export class CapturedIO implements ScriptIO {
  out = "";
  err = "";
  private readonly reader: LineReader;

  constructor(private readonly input = "") {
    this.reader = new LineReader(() => this.stdinStream());
  }

  stdout(text: string): void {
    this.out += text;
  }

  stderr(text: string): void {
    this.err += text;
  }

  readline(): Promise<string> {
    return this.reader.readline();
  }

  async *stdinStream(): AsyncIterable<Uint8Array> {
    yield Buffer.from(this.input);
  }
}

let currentIO: ScriptIO | null = null;

/** Return IO used by scripts. */
export function getIO(): ScriptIO {
  currentIO ??= processIO();
  return currentIO;
}

/** Change IO used by scripts. Returns previous IO. */
export function setIO(io: ScriptIO | null): ScriptIO | null {
  const previous = currentIO;
  currentIO = io;
  return previous;
}

/** Python-like print to standard output. */
export function print(...values: unknown[]): void {
  getIO().stdout(values.map((v) => String(v)).join(" ") + "\n");
}

/** Python-like print to standard error. */
export function eprint(...values: unknown[]): void {
  getIO().stderr(values.map((v) => String(v)).join(" ") + "\n");
}
