/** Helpers for working with binary data (Python bytes/struct equivalents). */

export type Bytes = Buffer;

export function toBuffer(data: Uint8Array | ArrayBuffer | string | number[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === "string") return Buffer.from(data, "utf-8");
  if (Array.isArray(data)) return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

export function concat(...parts: Array<Uint8Array | string>): Buffer {
  return Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "utf-8") : p)));
}

export function hex(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("hex");
}

export function fromHex(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, ""), "hex");
}

export function bytesEqual(a: Uint8Array | null | undefined, b: Uint8Array | null | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Equivalent of int.from_bytes(data, byteorder). */
export function intFromBytes(data: Uint8Array, byteorder: "little" | "big"): bigint {
  let result = 0n;
  if (byteorder === "big") {
    for (const b of data) result = (result << 8n) | BigInt(b);
  } else {
    for (let i = data.length - 1; i >= 0; i--) result = (result << 8n) | BigInt(data[i]!);
  }
  return result;
}

/** Equivalent of int.from_bytes returning a number (must fit in 53 bits). */
export function numFromBytes(data: Uint8Array, byteorder: "little" | "big"): number {
  return Number(intFromBytes(data, byteorder));
}

/** Equivalent of int.to_bytes(length, byteorder). */
export function intToBytes(value: number | bigint, length: number, byteorder: "little" | "big"): Buffer {
  let v = BigInt(value);
  if (v < 0n) throw new RangeError("can't convert negative int to unsigned");
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    const idx = byteorder === "little" ? i : length - 1 - i;
    out[idx] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new RangeError("int too big to convert");
  return out;
}

/** Return number of bytes needed to represent integer (like (n.bit_length()+7)//8). */
export function byteLength(value: bigint): number {
  let len = 0;
  let v = value;
  while (v > 0n) {
    v >>= 8n;
    len++;
  }
  return len;
}

/** Repeat a buffer n times (b"x" * n). */
export function repeat(data: Uint8Array | string, count: number): Buffer {
  const buf = typeof data === "string" ? Buffer.from(data, "latin1") : Buffer.from(data);
  return Buffer.concat(Array.from({ length: count }, () => buf));
}

/** Create a buffer from a latin1 string, handy for porting Python byte literals. */
export function b(text: string): Buffer {
  return Buffer.from(text, "latin1");
}

// --- struct ----------------------------------------------------------------

type StructValue = number | bigint | boolean | Buffer | string;

interface FormatItem {
  code: string;
  count: number;
}

function parseFormat(fmt: string): { little: boolean; items: FormatItem[] } {
  let little = false;
  let i = 0;
  if (fmt.length > 0 && "<>!=@".includes(fmt[0]!)) {
    little = fmt[0] === "<" || ((fmt[0] === "=" || fmt[0] === "@") && osLittle);
    i = 1;
  } else {
    little = osLittle;
  }
  const items: FormatItem[] = [];
  while (i < fmt.length) {
    let countStr = "";
    while (i < fmt.length && /\d/.test(fmt[i]!)) countStr += fmt[i++];
    if (i >= fmt.length) break;
    const code = fmt[i++]!;
    if (code === " ") continue;
    items.push({ code, count: countStr ? parseInt(countStr, 10) : 1 });
  }
  return { little, items };
}

const osLittle = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

const SIZES: Record<string, number> = {
  x: 1,
  c: 1,
  b: 1,
  B: 1,
  "?": 1,
  h: 2,
  H: 2,
  i: 4,
  I: 4,
  l: 4,
  L: 4,
  q: 8,
  Q: 8,
  e: 2,
  f: 4,
  d: 8,
  s: 1,
  p: 1,
};

/** Equivalent of struct.calcsize. */
export function calcsize(fmt: string): number {
  const { items } = parseFormat(fmt);
  let size = 0;
  for (const item of items) {
    const s = SIZES[item.code];
    if (s === undefined) throw new Error(`bad char in struct format: ${item.code}`);
    size += s * item.count;
  }
  return size;
}

/** Equivalent of struct.pack. q/Q accept number or bigint. */
export function pack(fmt: string, ...values: StructValue[]): Buffer {
  const { little, items } = parseFormat(fmt);
  const out = Buffer.alloc(calcsize(fmt));
  let offset = 0;
  let vi = 0;
  const next = (): StructValue => {
    if (vi >= values.length) throw new Error("pack expected more items for packing");
    return values[vi++]!;
  };
  for (const item of items) {
    if (item.code === "s" || item.code === "p") {
      const val = next();
      const data = typeof val === "string" ? Buffer.from(val, "latin1") : (val as Buffer);
      data.copy(out, offset, 0, Math.min(item.count, data.length));
      offset += item.count;
      continue;
    }
    for (let c = 0; c < item.count; c++) {
      switch (item.code) {
        case "x":
          offset += 1;
          break;
        case "c": {
          const v = next() as Buffer;
          out[offset] = v[0]!;
          offset += 1;
          break;
        }
        case "b":
          out.writeInt8(Number(next()), offset);
          offset += 1;
          break;
        case "B":
          out.writeUInt8(Number(next()), offset);
          offset += 1;
          break;
        case "?":
          out.writeUInt8(next() ? 1 : 0, offset);
          offset += 1;
          break;
        case "h":
          little ? out.writeInt16LE(Number(next()), offset) : out.writeInt16BE(Number(next()), offset);
          offset += 2;
          break;
        case "H":
          little ? out.writeUInt16LE(Number(next()), offset) : out.writeUInt16BE(Number(next()), offset);
          offset += 2;
          break;
        case "i":
        case "l":
          little ? out.writeInt32LE(Number(next()), offset) : out.writeInt32BE(Number(next()), offset);
          offset += 4;
          break;
        case "I":
        case "L":
          little ? out.writeUInt32LE(Number(next()), offset) : out.writeUInt32BE(Number(next()), offset);
          offset += 4;
          break;
        case "q":
          little
            ? out.writeBigInt64LE(BigInt(next() as number), offset)
            : out.writeBigInt64BE(BigInt(next() as number), offset);
          offset += 8;
          break;
        case "Q":
          little
            ? out.writeBigUInt64LE(BigInt(next() as number), offset)
            : out.writeBigUInt64BE(BigInt(next() as number), offset);
          offset += 8;
          break;
        case "f":
          little ? out.writeFloatLE(Number(next()), offset) : out.writeFloatBE(Number(next()), offset);
          offset += 4;
          break;
        case "d":
          little ? out.writeDoubleLE(Number(next()), offset) : out.writeDoubleBE(Number(next()), offset);
          offset += 8;
          break;
        default:
          throw new Error(`unsupported struct code ${item.code}`);
      }
    }
  }
  if (vi !== values.length) throw new Error(`pack expected ${vi} items for packing (got ${values.length})`);
  return out;
}

/**
 * Equivalent of struct.unpack. q/Q are returned as bigint, s as Buffer.
 */
export function unpack(fmt: string, data: Uint8Array, offset = 0): any[] {
  const { little, items } = parseFormat(fmt);
  const size = calcsize(fmt);
  if (data.length - offset < size) {
    throw new Error(`unpack requires a buffer of ${size} bytes`);
  }
  const buf = toBuffer(data);
  const out: any[] = [];
  let o = offset;
  for (const item of items) {
    if (item.code === "s" || item.code === "p") {
      out.push(Buffer.from(buf.subarray(o, o + item.count)));
      o += item.count;
      continue;
    }
    for (let c = 0; c < item.count; c++) {
      switch (item.code) {
        case "x":
          o += 1;
          break;
        case "c":
          out.push(Buffer.from(buf.subarray(o, o + 1)));
          o += 1;
          break;
        case "b":
          out.push(buf.readInt8(o));
          o += 1;
          break;
        case "B":
          out.push(buf.readUInt8(o));
          o += 1;
          break;
        case "?":
          out.push(buf.readUInt8(o) !== 0);
          o += 1;
          break;
        case "h":
          out.push(little ? buf.readInt16LE(o) : buf.readInt16BE(o));
          o += 2;
          break;
        case "H":
          out.push(little ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
          o += 2;
          break;
        case "i":
        case "l":
          out.push(little ? buf.readInt32LE(o) : buf.readInt32BE(o));
          o += 4;
          break;
        case "I":
        case "L":
          out.push(little ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
          o += 4;
          break;
        case "q":
          out.push(little ? buf.readBigInt64LE(o) : buf.readBigInt64BE(o));
          o += 8;
          break;
        case "Q":
          out.push(little ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o));
          o += 8;
          break;
        case "f":
          out.push(little ? buf.readFloatLE(o) : buf.readFloatBE(o));
          o += 4;
          break;
        case "d":
          out.push(little ? buf.readDoubleLE(o) : buf.readDoubleBE(o));
          o += 8;
          break;
        default:
          throw new Error(`unsupported struct code ${item.code}`);
      }
    }
  }
  return out;
}

/** A simple reader for sequential parsing (io.BytesIO equivalent). */
export class BytesReader {
  position = 0;
  readonly data: Buffer;

  constructor(data: Uint8Array) {
    this.data = toBuffer(data);
  }

  read(size?: number): Buffer {
    const end = size === undefined || size < 0 ? this.data.length : Math.min(this.position + size, this.data.length);
    const out = this.data.subarray(this.position, end);
    this.position = end;
    return Buffer.from(out);
  }

  tell(): number {
    return this.position;
  }

  seek(position: number): void {
    this.position = position;
  }

  unpack(fmt: string): any[] {
    const size = calcsize(fmt);
    const chunk = this.read(size);
    return unpack(fmt, chunk);
  }

  get remaining(): number {
    return this.data.length - this.position;
  }
}
