/**
 * Minimal protobuf (proto2) runtime with semantics similar to Python's protobuf.
 *
 * - Scalar fields return their default value when unset, presence is checked with
 *   hasField(name).
 * - Accessing an unset message field returns an (attached) empty message. Setting a
 *   value in it makes it present in the parent (just like in Python).
 * - Repeated fields are arrays (RepeatedField) with an add() helper for messages.
 * - Unknown fields are preserved when re-serializing.
 */

import { setProtobufFormatter } from "../../../support/index.ts";

export type ScalarType =
  | "double"
  | "float"
  | "int32"
  | "int64"
  | "uint32"
  | "uint64"
  | "sint32"
  | "sint64"
  | "fixed32"
  | "fixed64"
  | "sfixed32"
  | "sfixed64"
  | "bool"
  | "string"
  | "bytes";

export type FieldType = ScalarType | "enum" | "message";

export interface EnumInfo {
  readonly name: string;
  readonly values: Readonly<Record<string, number>>;
  readonly names: ReadonlyMap<number, string>;
  readonly defaultValue: number;
}

export interface FieldInfo {
  readonly name: string;
  readonly number: number;
  readonly type: FieldType;
  readonly repeated: boolean;
  readonly extension: boolean;
  readonly message?: () => MessageClass;
  readonly enum?: EnumInfo;
}

export interface MessageInfo {
  readonly name: string;
  readonly fields: readonly FieldInfo[];
  readonly byName: ReadonlyMap<string, FieldInfo>;
  readonly byNumber: ReadonlyMap<number, FieldInfo>;
}

export type MessageClass<T extends Message = Message> = {
  new (init?: Record<string, unknown>): T;
  readonly info: MessageInfo;
};

/** Define an enum. */
export function defineEnum(name: string, values: Record<string, number>): EnumInfo {
  const names = new Map<number, string>();
  for (const [key, value] of Object.entries(values)) {
    if (!names.has(value)) names.set(value, key);
  }
  const first = Object.values(values)[0] ?? 0;
  return { name, values, names, defaultValue: first };
}

/** Define message info lazily (fields resolved on first access). */
export function defineMessage(name: string, fields: () => FieldInfo[]): MessageInfo {
  let resolved: { fields: FieldInfo[]; byName: Map<string, FieldInfo>; byNumber: Map<number, FieldInfo> } | null =
    null;
  const resolve = () => {
    if (!resolved) {
      const list = fields().sort((a, b) => a.number - b.number);
      resolved = {
        fields: list,
        byName: new Map(list.map((f) => [f.name, f])),
        byNumber: new Map(list.map((f) => [f.number, f])),
      };
    }
    return resolved;
  };
  return {
    name,
    get fields() {
      return resolve().fields;
    },
    get byName() {
      return resolve().byName;
    },
    get byNumber() {
      return resolve().byNumber;
    },
  };
}

/** Define a field. */
export function field(
  name: string,
  number: number,
  type: FieldType,
  options: { repeated?: boolean; extension?: boolean; message?: () => MessageClass; enum?: EnumInfo } = {},
): FieldInfo {
  return {
    name,
    number,
    type,
    repeated: options.repeated ?? false,
    extension: options.extension ?? false,
    message: options.message,
    enum: options.enum,
  };
}

/** Raised when parsing invalid protobuf data. */
export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecodeError";
  }
}

/** Array used for repeated fields. */
export class RepeatedField<T> extends Array<T> {
  messageClass?: MessageClass;

  static override get [Symbol.species]() {
    return Array;
  }

  /** Add a new message to the list (only for message fields) and return it. */
  add(init?: Record<string, unknown>): T {
    if (!this.messageClass) throw new TypeError("add() only supported for message fields");
    const item = new this.messageClass(init) as unknown as T;
    this.push(item);
    return item;
  }

  /** Python compatible alias for push. */
  append(item: T): void {
    this.push(item);
  }

  /** Append all items from another iterable. */
  extend(items: Iterable<T>): void {
    for (const item of items) this.push(item);
  }

  clear(): void {
    this.length = 0;
  }
}

function defaultFor(info: FieldInfo): unknown {
  switch (info.type) {
    case "string":
      return "";
    case "bytes":
      return Buffer.alloc(0);
    case "bool":
      return false;
    case "enum":
      return info.enum?.defaultValue ?? 0;
    case "message":
      return undefined;
    default:
      return 0;
  }
}

/** Base class for all messages. */
export abstract class Message {
  private readonly _values = new Map<string, unknown>();
  private readonly _present = new Set<string>();
  private _unknown: Buffer[] = [];

  constructor(init?: Record<string, unknown>) {
    if (init) {
      for (const [key, value] of Object.entries(init)) {
        if (value === undefined) continue;
        if (!this.$info.byName.has(key)) {
          throw new TypeError(`${this.$info.name} has no field "${key}"`);
        }
        (this as any)[key] = value;
      }
    }
  }

  /** Message info (descriptor). */
  get $info(): MessageInfo {
    return (this.constructor as MessageClass).info;
  }

  private _field(name: string): FieldInfo {
    const info = this.$info.byName.get(name);
    if (!info) throw new Error(`${this.$info.name} has no field "${name}"`);
    return info;
  }

  protected _get(name: string): any {
    const info = this._field(name);
    if (info.repeated) {
      let list = this._values.get(name) as RepeatedField<unknown> | undefined;
      if (!list) {
        list = new RepeatedField<unknown>();
        if (info.type === "message") list.messageClass = info.message!();
        this._values.set(name, list);
      }
      return list;
    }
    if (this._values.has(name)) return this._values.get(name);
    if (info.type === "message") {
      // Auto-vivify sub message (present only if something is set in it)
      const child = new (info.message!())();
      this._values.set(name, child);
      return child;
    }
    return defaultFor(info);
  }

  protected _set(name: string, value: unknown): void {
    const info = this._field(name);
    if (value === undefined || value === null) {
      this.clearField(name);
      return;
    }
    if (info.repeated) {
      const list = new RepeatedField<unknown>();
      if (info.type === "message") list.messageClass = info.message!();
      for (const item of value as Iterable<unknown>) list.push(item);
      this._values.set(name, list);
      return;
    }
    if (info.type === "message") {
      const cls = info.message!();
      const msg = value instanceof cls ? value : new cls(value as Record<string, unknown>);
      this._values.set(name, msg);
      this._present.add(name);
      return;
    }
    if (info.type === "bytes" && !(value instanceof Uint8Array)) {
      throw new TypeError(`${this.$info.name}.${name} expects bytes`);
    }
    if (info.type === "bytes" && !Buffer.isBuffer(value)) {
      value = Buffer.from(value as Uint8Array);
    }
    this._values.set(name, value);
  }

  /** Return if a field is set. */
  hasField(name: string): boolean {
    const info = this._field(name);
    if (info.repeated) {
      const list = this._values.get(name) as unknown[] | undefined;
      return list !== undefined && list.length > 0;
    }
    if (info.type === "message") {
      if (this._present.has(name)) return true;
      const child = this._values.get(name) as Message | undefined;
      return child !== undefined && child.hasAnyField();
    }
    return this._values.has(name);
  }

  /** Return if any field is set in this message. */
  hasAnyField(): boolean {
    if (this._unknown.length > 0) return true;
    for (const info of this.$info.fields) {
      if (this.hasField(info.name)) return true;
    }
    return false;
  }

  /** Mark a message as present even if empty (SetInParent in Python). */
  setInParent(name: string): void {
    this._get(name);
    this._present.add(name);
  }

  /** Clear a field. */
  clearField(name: string): void {
    this._field(name);
    this._values.delete(name);
    this._present.delete(name);
  }

  /** Clear all fields. */
  clear(): void {
    this._values.clear();
    this._present.clear();
    this._unknown = [];
  }

  /** Return list of [field info, value] for all set fields (sorted by number). */
  listFields(): Array<[FieldInfo, any]> {
    return this.$info.fields.filter((f) => this.hasField(f.name)).map((f) => [f, this._get(f.name)]);
  }

  /** Merge fields from another message of same type. */
  mergeFrom(other: Message): void {
    if (other.$info !== this.$info) throw new TypeError("can only merge messages of same type");
    for (const [info, value] of other.listFields()) {
      if (info.repeated) {
        const list = this._get(info.name) as RepeatedField<unknown>;
        for (const item of value as unknown[]) {
          list.push(info.type === "message" ? (item as Message).clone() : item);
        }
      } else if (info.type === "message") {
        const target = this._get(info.name) as Message;
        target.mergeFrom(value as Message);
        this._present.add(info.name);
      } else {
        this._values.set(info.name, value);
      }
    }
    this._unknown.push(...other._unknown);
  }

  /** Replace content with a copy of another message. */
  copyFrom(other: Message): void {
    this.clear();
    this.mergeFrom(other);
  }

  /** Create a deep copy of this message. */
  clone(): this {
    const copy = new (this.constructor as new () => this)();
    copy.mergeFrom(this);
    return copy;
  }

  /** Serialize message to bytes. */
  serializeToString(): Buffer {
    const writer = new Writer();
    encodeMessage(this, writer);
    return writer.finish();
  }

  /** Parse bytes into this message (fields are merged). */
  mergeFromString(data: Uint8Array): this {
    decodeMessage(this, data);
    return this;
  }

  /** Parse bytes into this message (existing content is cleared). */
  parseFromString(data: Uint8Array): this {
    this.clear();
    return this.mergeFromString(data);
  }

  /** Parse bytes into a new message of the given class. */
  static decode<T extends Message>(this: MessageClass<T>, data: Uint8Array): T {
    return new this().parseFromString(data);
  }

  /** Return unknown fields (raw encoded). */
  get unknownFields(): readonly Buffer[] {
    return this._unknown;
  }

  /** @internal */
  _addUnknown(raw: Buffer): void {
    this._unknown.push(raw);
  }

  /** @internal */
  _rawGet(name: string): unknown {
    return this._get(name);
  }

  /** @internal */
  _rawSet(name: string, value: unknown): void {
    this._set(name, value);
  }

  /** Compare with another message (by serialized content). */
  equals(other: unknown): boolean {
    return (
      other instanceof Message &&
      other.$info === this.$info &&
      this.serializeToString().equals(other.serializeToString())
    );
  }

  /** Text format representation (like Python's text_format). */
  toString(): string {
    return messageToString(this);
  }

  /** Plain object representation (useful for debugging). */
  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [info, value] of this.listFields()) {
      if (info.type === "message") {
        out[info.name] = info.repeated ? (value as Message[]).map((m) => m.toJSON()) : (value as Message).toJSON();
      } else if (info.type === "bytes") {
        out[info.name] = info.repeated
          ? (value as Buffer[]).map((b) => b.toString("hex"))
          : (value as Buffer).toString("hex");
      } else {
        out[info.name] = info.repeated ? [...(value as unknown[])] : value;
      }
    }
    return out;
  }
}

// --- Encoding -------------------------------------------------------------------

class Writer {
  private chunks: Buffer[] = [];

  varint(value: bigint | number): void {
    let v = BigInt(value);
    if (v < 0n) v = BigInt.asUintN(64, v);
    const bytes: number[] = [];
    while (v >= 0x80n) {
      bytes.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    bytes.push(Number(v));
    this.chunks.push(Buffer.from(bytes));
  }

  tag(number: number, wireType: number): void {
    this.varint((number << 3) | wireType);
  }

  raw(data: Uint8Array): void {
    this.chunks.push(Buffer.from(data));
  }

  bytes(data: Uint8Array): void {
    this.varint(data.length);
    this.raw(data);
  }

  finish(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

function wireTypeFor(type: FieldType): number {
  switch (type) {
    case "double":
    case "fixed64":
    case "sfixed64":
      return 1;
    case "float":
    case "fixed32":
    case "sfixed32":
      return 5;
    case "string":
    case "bytes":
    case "message":
      return 2;
    default:
      return 0;
  }
}

function encodeValue(writer: Writer, info: FieldInfo, value: unknown): void {
  writer.tag(info.number, wireTypeFor(info.type));
  switch (info.type) {
    case "int32":
    case "int64":
    case "uint32":
    case "uint64":
    case "enum":
      writer.varint(typeof value === "bigint" ? value : BigInt(Math.trunc(Number(value))));
      break;
    case "bool":
      writer.varint(value ? 1 : 0);
      break;
    case "sint32":
    case "sint64": {
      const v = BigInt(value as number);
      writer.varint(v >= 0n ? v << 1n : (-v << 1n) - 1n);
      break;
    }
    case "fixed32": {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(Number(value) >>> 0);
      writer.raw(b);
      break;
    }
    case "sfixed32": {
      const b = Buffer.alloc(4);
      b.writeInt32LE(Number(value));
      writer.raw(b);
      break;
    }
    case "float": {
      const b = Buffer.alloc(4);
      b.writeFloatLE(Number(value));
      writer.raw(b);
      break;
    }
    case "fixed64": {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(BigInt.asUintN(64, BigInt(value as number)));
      writer.raw(b);
      break;
    }
    case "sfixed64": {
      const b = Buffer.alloc(8);
      b.writeBigInt64LE(BigInt(value as number));
      writer.raw(b);
      break;
    }
    case "double": {
      const b = Buffer.alloc(8);
      b.writeDoubleLE(Number(value));
      writer.raw(b);
      break;
    }
    case "string":
      writer.bytes(Buffer.from(value as string, "utf-8"));
      break;
    case "bytes":
      writer.bytes(value as Uint8Array);
      break;
    case "message":
      writer.bytes((value as Message).serializeToString());
      break;
  }
}

function encodeMessage(msg: Message, writer: Writer): void {
  for (const [info, value] of msg.listFields()) {
    if (info.repeated) {
      for (const item of value as unknown[]) encodeValue(writer, info, item);
    } else {
      encodeValue(writer, info, value);
    }
  }
  for (const raw of msg.unknownFields) writer.raw(raw);
}

// --- Decoding -------------------------------------------------------------------

class Reader {
  pos = 0;
  constructor(readonly buf: Buffer) {}

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.pos >= this.buf.length) throw new DecodeError("truncated varint");
      const byte = this.buf[this.pos++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return result;
      shift += 7n;
      if (shift > 70n) throw new DecodeError("varint too long");
    }
  }

  take(length: number): Buffer {
    if (this.pos + length > this.buf.length) throw new DecodeError("truncated message");
    const out = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  skip(wireType: number): void {
    switch (wireType) {
      case 0:
        this.varint();
        break;
      case 1:
        this.take(8);
        break;
      case 2:
        this.take(Number(this.varint()));
        break;
      case 5:
        this.take(4);
        break;
      case 3: {
        // Start group: skip until matching end group
        for (;;) {
          const tag = Number(this.varint());
          if ((tag & 7) === 4) break;
          this.skip(tag & 7);
        }
        break;
      }
      default:
        throw new DecodeError(`invalid wire type ${wireType}`);
    }
  }
}

function toNumber(value: bigint): number | bigint {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value;
}

function decodeScalar(reader: Reader, info: FieldInfo, wireType: number): unknown {
  switch (info.type) {
    case "int32":
    case "enum":
      return Number(BigInt.asIntN(32, reader.varint()));
    case "int64":
      return toNumber(BigInt.asIntN(64, reader.varint()));
    case "uint32":
      return Number(BigInt.asUintN(32, reader.varint()));
    case "uint64":
      return toNumber(BigInt.asUintN(64, reader.varint()));
    case "bool":
      return reader.varint() !== 0n;
    case "sint32":
    case "sint64": {
      const v = reader.varint();
      return toNumber(v & 1n ? -((v + 1n) >> 1n) : v >> 1n);
    }
    case "fixed32":
      return reader.take(4).readUInt32LE(0);
    case "sfixed32":
      return reader.take(4).readInt32LE(0);
    case "float":
      return reader.take(4).readFloatLE(0);
    case "fixed64":
      return toNumber(reader.take(8).readBigUInt64LE(0));
    case "sfixed64":
      return toNumber(reader.take(8).readBigInt64LE(0));
    case "double":
      return reader.take(8).readDoubleLE(0);
    case "string":
      return reader.take(Number(reader.varint())).toString("utf-8");
    case "bytes":
      return Buffer.from(reader.take(Number(reader.varint())));
    case "message": {
      const data = reader.take(Number(reader.varint()));
      return new (info.message!())().mergeFromString(data);
    }
  }
  void wireType;
  return undefined;
}

function decodeMessage(msg: Message, data: Uint8Array): void {
  const reader = new Reader(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  while (!reader.done) {
    const start = reader.pos;
    const tag = Number(reader.varint());
    const number = tag >>> 3;
    const wireType = tag & 7;
    const info = msg.$info.byNumber.get(number);

    if (!info || (wireType !== wireTypeFor(info.type) && !(info.repeated && wireType === 2))) {
      reader.skip(wireType);
      msg._addUnknown(Buffer.from(reader.buf.subarray(start, reader.pos)));
      continue;
    }

    if (info.repeated) {
      const list = msg._rawGet(info.name) as RepeatedField<unknown>;
      if (wireType === 2 && wireTypeFor(info.type) !== 2) {
        // Packed repeated field
        const packed = new Reader(reader.take(Number(reader.varint())));
        while (!packed.done) list.push(decodeScalar(packed, info, wireTypeFor(info.type)));
      } else {
        list.push(decodeScalar(reader, info, wireType));
      }
    } else if (info.type === "message") {
      const sub = reader.take(Number(reader.varint()));
      const target = msg._rawGet(info.name) as Message;
      target.mergeFromString(sub);
      msg.setInParent(info.name);
    } else {
      msg._rawSet(info.name, decodeScalar(reader, info, wireType));
    }
  }
}

// --- Text format ------------------------------------------------------------------

function cEscape(data: Buffer): string {
  let out = "";
  for (const byte of data) {
    if (byte === 0x0a) out += "\\n";
    else if (byte === 0x0d) out += "\\r";
    else if (byte === 0x09) out += "\\t";
    else if (byte === 0x22) out += '\\"';
    else if (byte === 0x27) out += "\\'";
    else if (byte === 0x5c) out += "\\\\";
    else if (byte >= 0x20 && byte < 0x7f) out += String.fromCharCode(byte);
    else out += "\\" + byte.toString(8).padStart(3, "0");
  }
  return out;
}

function formatFloat(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  if (Number.isInteger(value)) return value.toFixed(1);
  return String(value);
}

function formatScalar(info: FieldInfo, value: unknown): string {
  switch (info.type) {
    case "string":
      return `"${cEscape(Buffer.from(value as string, "utf-8"))}"`;
    case "bytes":
      return `"${cEscape(value as Buffer)}"`;
    case "bool":
      return value ? "true" : "false";
    case "enum":
      return info.enum?.names.get(value as number) ?? String(value);
    case "float":
      return formatFloat(Math.fround(value as number));
    case "double":
      return formatFloat(value as number);
    default:
      return String(value);
  }
}

function formatUnknown(raw: Buffer, indent: string): string[] {
  const reader = new Reader(raw);
  const lines: string[] = [];
  while (!reader.done) {
    const tag = Number(reader.varint());
    const number = tag >>> 3;
    const wireType = tag & 7;
    if (wireType === 0) lines.push(`${indent}${number}: ${reader.varint()}`);
    else if (wireType === 1) lines.push(`${indent}${number}: 0x${reader.take(8).readBigUInt64LE(0).toString(16).padStart(16, "0")}`);
    else if (wireType === 5) lines.push(`${indent}${number}: 0x${reader.take(4).readUInt32LE(0).toString(16).padStart(8, "0")}`);
    else if (wireType === 2) lines.push(`${indent}${number}: "${cEscape(reader.take(Number(reader.varint())))}"`);
    else reader.skip(wireType);
  }
  return lines;
}

function formatMessage(msg: Message, indent: string, lines: string[]): void {
  for (const [info, value] of msg.listFields()) {
    const name = info.extension ? `[${info.name}]` : info.name;
    const items = info.repeated ? (value as unknown[]) : [value];
    for (const item of items) {
      if (info.type === "message") {
        lines.push(`${indent}${name} {`);
        formatMessage(item as Message, indent + "  ", lines);
        lines.push(`${indent}}`);
      } else {
        lines.push(`${indent}${name}: ${formatScalar(info, item)}`);
      }
    }
  }
  for (const raw of msg.unknownFields) lines.push(...formatUnknown(raw, indent));
}

/** Format a message using protobuf text format. */
export function messageToString(msg: Message): string {
  const lines: string[] = [];
  formatMessage(msg, "", lines);
  return lines.length > 0 ? lines.join("\n") + "\n" : "";
}

// Make log_protobuf use text format for messages
setProtobufFormatter((message) => (message instanceof Message ? messageToString(message) : String(message)));

/** Return name of an enum value (like Enum.Name in Python protobuf). */
export function enumName(values: Readonly<Record<string, number>>, value: number): string {
  for (const [key, v] of Object.entries(values)) if (v === value) return key;
  return String(value);
}
