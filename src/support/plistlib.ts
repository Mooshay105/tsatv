/**
 * Property list (plist) serialization, equivalent of Python's plistlib.
 *
 * Supports both binary (bplist00) and XML formats. Mapping of types:
 *  - dict <-> plain object (keys are strings)
 *  - array <-> Array
 *  - string <-> string
 *  - integer <-> number (bigint if it does not fit in a safe integer)
 *  - real <-> number (use Float to force an integral value to be encoded as real)
 *  - true/false <-> boolean
 *  - data <-> Buffer/Uint8Array
 *  - date <-> Date
 *  - UID <-> UID
 */

import { Float } from "./float.ts";

export enum PlistFormat {
  XML = 1,
  BINARY = 2,
}

export const FMT_XML = PlistFormat.XML;
export const FMT_BINARY = PlistFormat.BINARY;

/** Keyed archiver UID. */
export class UID {
  constructor(readonly data: number) {
    if (!Number.isInteger(data) || data < 0) throw new RangeError("UIDs must be positive integers");
  }

  equals(other: unknown): boolean {
    return other instanceof UID && other.data === this.data;
  }

  toString(): string {
    return `UID(${this.data})`;
  }
}

export class InvalidFileException extends Error {
  constructor(message = "Invalid file") {
    super(message);
    this.name = "InvalidFileException";
  }
}

// Seconds between 1970-01-01 and 2001-01-01
const APPLE_EPOCH_OFFSET = 978307200;

export interface DumpOptions {
  fmt?: PlistFormat;
  sortKeys?: boolean;
}

/** Serialize object to plist. Default format is XML (like Python). */
export function dumps(value: unknown, options: DumpOptions | PlistFormat = {}): Buffer {
  const opts: DumpOptions = typeof options === "number" ? { fmt: options } : options;
  const fmt = opts.fmt ?? PlistFormat.XML;
  const sortKeys = opts.sortKeys ?? true;
  if (fmt === PlistFormat.BINARY) return new BinaryWriter(sortKeys).write(value);
  return Buffer.from(writeXml(value, sortKeys), "utf-8");
}

/** Deserialize plist (auto detects binary or XML format). */
export function loads(data: Uint8Array | string): any {
  const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : Buffer.from(data);
  if (buf.subarray(0, 8).toString("latin1") === "bplist00") {
    return new BinaryReader(buf).parse();
  }
  return parseXml(buf.toString("utf-8"));
}

function isDict(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    !(value instanceof Date) &&
    !(value instanceof UID) &&
    !(value instanceof Float)
  );
}

function dictEntries(value: Record<string, unknown> | Map<string, unknown>, sortKeys: boolean): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = value instanceof Map ? [...value.entries()] : Object.entries(value);
  for (const [key] of entries) {
    if (typeof key !== "string") throw new TypeError("keys must be strings");
  }
  if (sortKeys) entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries;
}

// --- Binary writer -----------------------------------------------------------

function intSize(count: number): number {
  if (count < 1 << 8) return 1;
  if (count < 1 << 16) return 2;
  if (count < 2 ** 32) return 4;
  return 8;
}

function writeUInt(value: number, size: number): Buffer {
  const out = Buffer.alloc(size);
  if (size === 1) out.writeUInt8(value);
  else if (size === 2) out.writeUInt16BE(value);
  else if (size === 4) out.writeUInt32BE(value);
  else out.writeBigUInt64BE(BigInt(value));
  return out;
}

class BinaryWriter {
  private objects: unknown[] = [];
  private scalarRefs = new Map<string, number>();
  private containerRefs = new Map<object, number>();
  private refSize = 1;

  constructor(private readonly sortKeys: boolean) {}

  private scalarKey(value: unknown): string | null {
    if (value === null || value === undefined) return "n";
    if (typeof value === "boolean") return "b" + value;
    if (typeof value === "number") return (Number.isInteger(value) ? "i" : "f") + value;
    if (typeof value === "bigint") return "i" + value.toString();
    if (value instanceof Float) return "f" + value.value;
    if (typeof value === "string") return "s" + value;
    if (value instanceof Uint8Array) return "d" + Buffer.from(value).toString("hex");
    if (value instanceof Date) return "t" + value.getTime();
    if (value instanceof UID) return "u" + value.data;
    return null;
  }

  private flatten(value: unknown): void {
    const key = this.scalarKey(value);
    if (key !== null) {
      if (this.scalarRefs.has(key)) return;
      this.scalarRefs.set(key, this.objects.length);
    } else {
      if (this.containerRefs.has(value as object)) return;
      this.containerRefs.set(value as object, this.objects.length);
    }
    this.objects.push(value);

    if (key !== null) return;
    if (Array.isArray(value)) {
      for (const item of value) this.flatten(item);
    } else if (value instanceof Map || isDict(value)) {
      const entries = dictEntries(value as Record<string, unknown>, this.sortKeys);
      for (const [k] of entries) this.flatten(k);
      for (const [, v] of entries) this.flatten(v);
    } else {
      throw new TypeError(`unsupported type: ${typeof value}`);
    }
  }

  private ref(value: unknown): number {
    const key = this.scalarKey(value);
    const ref = key !== null ? this.scalarRefs.get(key) : this.containerRefs.get(value as object);
    if (ref === undefined) throw new Error("object not flattened");
    return ref;
  }

  private header(token: number, length: number): Buffer {
    if (length < 15) return Buffer.from([token | length]);
    const size = intSize(length);
    const sizeToken = { 1: 0x10, 2: 0x11, 4: 0x12, 8: 0x13 }[size]!;
    return Buffer.concat([Buffer.from([token | 0x0f, sizeToken]), writeUInt(length, size)]);
  }

  private refs(values: unknown[]): Buffer {
    return Buffer.concat(values.map((v) => writeUInt(this.ref(v), this.refSize)));
  }

  private encodeInt(value: bigint): Buffer {
    if (value < 0n) {
      const out = Buffer.alloc(9);
      out[0] = 0x13;
      out.writeBigInt64BE(value, 1);
      return out;
    }
    if (value < 1n << 8n) return Buffer.from([0x10, Number(value)]);
    if (value < 1n << 16n) return Buffer.concat([Buffer.from([0x11]), writeUInt(Number(value), 2)]);
    if (value < 1n << 32n) return Buffer.concat([Buffer.from([0x12]), writeUInt(Number(value), 4)]);
    if (value < 1n << 63n) {
      const out = Buffer.alloc(9);
      out[0] = 0x13;
      out.writeBigUInt64BE(value, 1);
      return out;
    }
    if (value < 1n << 64n) {
      const out = Buffer.alloc(17);
      out[0] = 0x14;
      out.writeBigUInt64BE(value, 9);
      return out;
    }
    throw new RangeError("integer out of range");
  }

  private encodeObject(value: unknown): Buffer {
    if (value === null || value === undefined) return Buffer.from([0x00]);
    if (value === false) return Buffer.from([0x08]);
    if (value === true) return Buffer.from([0x09]);
    if (typeof value === "bigint") return this.encodeInt(value);
    if (typeof value === "number" && Number.isInteger(value)) return this.encodeInt(BigInt(value));
    if (typeof value === "number" || value instanceof Float) {
      const out = Buffer.alloc(9);
      out[0] = 0x23;
      out.writeDoubleBE(Number(value), 1);
      return out;
    }
    if (value instanceof Date) {
      const out = Buffer.alloc(9);
      out[0] = 0x33;
      out.writeDoubleBE(value.getTime() / 1000 - APPLE_EPOCH_OFFSET, 1);
      return out;
    }
    if (value instanceof Uint8Array) {
      return Buffer.concat([this.header(0x40, value.length), value]);
    }
    if (typeof value === "string") {
      // eslint-disable-next-line no-control-regex
      if (/^[\x00-\x7f]*$/.test(value)) {
        return Buffer.concat([this.header(0x50, value.length), Buffer.from(value, "ascii")]);
      }
      const utf16 = Buffer.from(value, "utf16le");
      utf16.swap16();
      return Buffer.concat([this.header(0x60, utf16.length / 2), utf16]);
    }
    if (value instanceof UID) {
      const data = value.data;
      if (data < 1 << 8) return Buffer.from([0x80, data]);
      if (data < 1 << 16) return Buffer.concat([Buffer.from([0x81]), writeUInt(data, 2)]);
      if (data < 2 ** 32) return Buffer.concat([Buffer.from([0x83]), writeUInt(data, 4)]);
      return Buffer.concat([Buffer.from([0x87]), writeUInt(data, 8)]);
    }
    if (Array.isArray(value)) {
      return Buffer.concat([this.header(0xa0, value.length), this.refs(value)]);
    }
    const entries = dictEntries(value as Record<string, unknown>, this.sortKeys);
    return Buffer.concat([
      this.header(0xd0, entries.length),
      this.refs(entries.map(([k]) => k)),
      this.refs(entries.map(([, v]) => v)),
    ]);
  }

  write(value: unknown): Buffer {
    this.flatten(value);
    const numObjects = this.objects.length;
    this.refSize = intSize(numObjects);

    const parts: Buffer[] = [Buffer.from("bplist00", "latin1")];
    const offsets: number[] = [];
    let position = 8;
    for (const obj of this.objects) {
      offsets.push(position);
      const encoded = this.encodeObject(obj);
      parts.push(encoded);
      position += encoded.length;
    }

    const offsetTableOffset = position;
    const offsetSize = intSize(position);
    parts.push(Buffer.concat(offsets.map((o) => writeUInt(o, offsetSize))));

    const trailer = Buffer.alloc(32);
    trailer[6] = offsetSize;
    trailer[7] = this.refSize;
    trailer.writeBigUInt64BE(BigInt(numObjects), 8);
    trailer.writeBigUInt64BE(BigInt(this.ref(value)), 16);
    trailer.writeBigUInt64BE(BigInt(offsetTableOffset), 24);
    parts.push(trailer);
    return Buffer.concat(parts);
  }
}

// --- Binary reader -----------------------------------------------------------

class BinaryReader {
  private offsets: number[] = [];
  private refSize = 1;
  private objects = new Map<number, unknown>();

  constructor(private readonly data: Buffer) {}

  private readUInt(offset: number, size: number): number {
    let result = 0;
    for (let i = 0; i < size; i++) result = result * 256 + this.data[offset + i]!;
    return result;
  }

  parse(): unknown {
    const data = this.data;
    if (data.length < 40) throw new InvalidFileException();
    const trailer = data.subarray(data.length - 32);
    const offsetSize = trailer[6]!;
    this.refSize = trailer[7]!;
    const numObjects = Number(trailer.readBigUInt64BE(8));
    const topObject = Number(trailer.readBigUInt64BE(16));
    const offsetTableOffset = Number(trailer.readBigUInt64BE(24));
    for (let i = 0; i < numObjects; i++) {
      this.offsets.push(this.readUInt(offsetTableOffset + i * offsetSize, offsetSize));
    }
    return this.readObject(topObject);
  }

  private readLength(offset: number, info: number): [number, number] {
    if (info !== 0x0f) return [info, offset];
    const marker = this.data[offset]!;
    if ((marker & 0xf0) !== 0x10) throw new InvalidFileException("bad length marker");
    const size = 1 << (marker & 0x0f);
    return [this.readUInt(offset + 1, size), offset + 1 + size];
  }

  private readRefs(offset: number, count: number): number[] {
    const refs: number[] = [];
    for (let i = 0; i < count; i++) refs.push(this.readUInt(offset + i * this.refSize, this.refSize));
    return refs;
  }

  private readObject(ref: number): unknown {
    if (this.objects.has(ref)) return this.objects.get(ref);
    const offset = this.offsets[ref];
    if (offset === undefined) throw new InvalidFileException("bad object reference");
    const data = this.data;
    const token = data[offset]!;
    const type = token & 0xf0;
    const info = token & 0x0f;
    let result: unknown;

    if (token === 0x00) result = null;
    else if (token === 0x08) result = false;
    else if (token === 0x09) result = true;
    else if (token === 0x0f) result = Buffer.alloc(0);
    else if (type === 0x10) {
      const size = 1 << info;
      if (size === 16) {
        result = data.readBigUInt64BE(offset + 9);
      } else if (size === 8) {
        const value = data.readBigInt64BE(offset + 1);
        result = value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
      } else {
        result = this.readUInt(offset + 1, size);
      }
    } else if (token === 0x22) result = data.readFloatBE(offset + 1);
    else if (token === 0x23) result = data.readDoubleBE(offset + 1);
    else if (token === 0x33) result = new Date((data.readDoubleBE(offset + 1) + APPLE_EPOCH_OFFSET) * 1000);
    else if (type === 0x40) {
      const [length, start] = this.readLength(offset + 1, info);
      result = Buffer.from(data.subarray(start, start + length));
    } else if (type === 0x50) {
      const [length, start] = this.readLength(offset + 1, info);
      result = data.subarray(start, start + length).toString("ascii");
    } else if (type === 0x60) {
      const [length, start] = this.readLength(offset + 1, info);
      const chars = Buffer.from(data.subarray(start, start + length * 2));
      chars.swap16();
      result = chars.toString("utf16le");
    } else if (type === 0x80) {
      result = new UID(this.readUInt(offset + 1, info + 1));
    } else if (type === 0xa0) {
      const [count, start] = this.readLength(offset + 1, info);
      const arr: unknown[] = [];
      this.objects.set(ref, arr);
      for (const r of this.readRefs(start, count)) arr.push(this.readObject(r));
      return arr;
    } else if (type === 0xd0) {
      const [count, start] = this.readLength(offset + 1, info);
      const dict: Record<string, unknown> = {};
      this.objects.set(ref, dict);
      const keys = this.readRefs(start, count);
      const values = this.readRefs(start + count * this.refSize, count);
      for (let i = 0; i < count; i++) {
        dict[String(this.readObject(keys[i]!))] = this.readObject(values[i]!);
      }
      return dict;
    } else {
      throw new InvalidFileException(`unknown object type 0x${token.toString(16)}`);
    }
    this.objects.set(ref, result);
    return result;
  }
}

// --- XML ---------------------------------------------------------------------

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}

function formatDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function writeXml(value: unknown, sortKeys: boolean): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
  ];
  const write = (v: unknown, indent: string): void => {
    if (v === null || v === undefined) throw new TypeError("None is not supported in XML plists");
    if (v === true) lines.push(`${indent}<true/>`);
    else if (v === false) lines.push(`${indent}<false/>`);
    else if (typeof v === "bigint" || (typeof v === "number" && Number.isInteger(v)))
      lines.push(`${indent}<integer>${v}</integer>`);
    else if (typeof v === "number" || v instanceof Float) lines.push(`${indent}<real>${Number(v)}</real>`);
    else if (typeof v === "string") lines.push(`${indent}<string>${escapeXml(v)}</string>`);
    else if (v instanceof Date) lines.push(`${indent}<date>${formatDate(v)}</date>`);
    else if (v instanceof Uint8Array) {
      lines.push(`${indent}<data>`);
      const b64 = Buffer.from(v).toString("base64");
      for (let i = 0; i < b64.length; i += 76) lines.push(`${indent}${b64.slice(i, i + 76)}`);
      lines.push(`${indent}</data>`);
    } else if (v instanceof UID) {
      throw new TypeError("UID is not supported in XML plists");
    } else if (Array.isArray(v)) {
      if (v.length === 0) lines.push(`${indent}<array/>`);
      else {
        lines.push(`${indent}<array>`);
        for (const item of v) write(item, indent + "\t");
        lines.push(`${indent}</array>`);
      }
    } else {
      const entries = dictEntries(v as Record<string, unknown>, sortKeys);
      if (entries.length === 0) lines.push(`${indent}<dict/>`);
      else {
        lines.push(`${indent}<dict>`);
        for (const [key, item] of entries) {
          lines.push(`${indent}\t<key>${escapeXml(key)}</key>`);
          write(item, indent + "\t");
        }
        lines.push(`${indent}</dict>`);
      }
    }
  };
  write(value, "");
  lines.push("</plist>", "");
  return lines.join("\n");
}

interface XmlNode {
  tag: string;
  children: XmlNode[];
  text: string;
}

function parseXmlTree(text: string): XmlNode {
  const root: XmlNode = { tag: "#root", children: [], text: "" };
  const stack: XmlNode[] = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([a-zA-Z0-9_:-]+)([^>]*?)(\/?)>|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const [, closing, tag, , selfClosing, content] = match;
    const current = stack[stack.length - 1]!;
    if (content !== undefined) {
      current.text += content;
    } else if (tag) {
      if (closing) {
        if (current.tag !== tag) throw new InvalidFileException(`mismatched tag ${tag}`);
        stack.pop();
      } else {
        const node: XmlNode = { tag, children: [], text: "" };
        current.children.push(node);
        if (!selfClosing) stack.push(node);
      }
    }
  }
  return root;
}

function parseXml(text: string): unknown {
  const root = parseXmlTree(text);
  const plist = root.children.find((c) => c.tag === "plist");
  if (!plist || plist.children.length === 0) throw new InvalidFileException();
  const convert = (node: XmlNode): unknown => {
    switch (node.tag) {
      case "dict": {
        const out: Record<string, unknown> = {};
        for (let i = 0; i < node.children.length; i += 2) {
          const key = node.children[i]!;
          const value = node.children[i + 1];
          if (key.tag !== "key" || !value) throw new InvalidFileException("bad dict");
          out[unescapeXml(key.text)] = convert(value);
        }
        return out;
      }
      case "array":
        return node.children.map(convert);
      case "string":
        return unescapeXml(node.text);
      case "integer": {
        const value = BigInt(node.text.trim());
        return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
      }
      case "real":
        return parseFloat(node.text.trim());
      case "true":
        return true;
      case "false":
        return false;
      case "data":
        return Buffer.from(node.text.replace(/\s+/g, ""), "base64");
      case "date":
        return new Date(node.text.trim());
      default:
        throw new InvalidFileException(`unknown tag ${node.tag}`);
    }
  };
  return convert(plist.children[0]!);
}
