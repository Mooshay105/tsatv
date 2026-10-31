/**
 * Support for the OPACK serialization format.
 *
 * Notes:
 *  - Absolute time (0x06) is not implemented (can unpack as integer, not pack)
 *  - Pack implementation does not implement UID referencing
 *  - Dictionaries are unpacked as plain objects when all keys are strings, otherwise
 *    as Map instances. Both plain objects and Maps can be packed.
 *  - Integers that do not fit in a JavaScript number are represented as bigint.
 *  - Use OpackFloat to force packing of an integral value as a float and SizedInt to
 *    force a specific integer size.
 */

import { NotImplementedError } from "../exceptions.ts";
import { intToBytes } from "./bytes.ts";
import { Float } from "./float.ts";
import { UUID } from "./uuid.ts";

/** Integer with explicit encoded size (1, 2, 4 or 8 bytes). */
export class SizedInt {
  constructor(
    readonly value: number | bigint,
    readonly size: number,
  ) {}

  valueOf(): number {
    return Number(this.value);
  }
}

/** Create a sized integer (equivalent of Python's _sized_int). */
export function sizedInt(value: number | bigint, size: number): SizedInt {
  return new SizedInt(value, size);
}

/** Wrapper forcing a number to be packed as a float64. */
export const OpackFloat = Float;
export type OpackFloat = Float;

export type OpackValue =
  | null
  | undefined
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | UUID
  | SizedInt
  | OpackFloat
  | OpackValue[]
  | Map<OpackValue, OpackValue>
  | { [key: string]: OpackValue };

/** Pack data structure with OPACK and return bytes. */
export function pack(data: unknown): Buffer {
  return _pack(data, new Map());
}

function lenBytes(length: number, size: number): Buffer {
  return intToBytes(length, size, "little");
}

function packInt(value: bigint, sizeHint: number | null): Buffer {
  if (value < 0n) throw new TypeError("negative integers not supported");
  if (value < 0x28n && !sizeHint) return Buffer.from([Number(value) + 8]);
  if ((value <= 0xffn && !sizeHint) || sizeHint === 1) return Buffer.concat([Buffer.from([0x30]), intToBytes(value, 1, "little")]);
  if ((value <= 0xffffn && !sizeHint) || sizeHint === 2) return Buffer.concat([Buffer.from([0x31]), intToBytes(value, 2, "little")]);
  if ((value <= 0xffffffffn && !sizeHint) || sizeHint === 4) return Buffer.concat([Buffer.from([0x32]), intToBytes(value, 4, "little")]);
  if (value <= 0xffffffffffffffffn) return Buffer.concat([Buffer.from([0x33]), intToBytes(value, 8, "little")]);
  throw new TypeError("integer too large");
}

function packFloat(value: number): Buffer {
  const out = Buffer.alloc(9);
  out[0] = 0x36;
  out.writeDoubleLE(value, 1);
  return out;
}

function _pack(data: unknown, objectList: Map<string, number>): Buffer {
  let packed: Buffer;
  if (data === null || data === undefined) {
    packed = Buffer.from([0x04]);
  } else if (typeof data === "boolean") {
    packed = Buffer.from([data ? 1 : 2]);
  } else if (data instanceof UUID) {
    packed = Buffer.concat([Buffer.from([0x05]), data.bytes]);
  } else if (data instanceof Date) {
    throw new NotImplementedError("absolute time");
  } else if (data instanceof SizedInt) {
    packed = packInt(BigInt(data.value), data.size);
  } else if (data instanceof Float) {
    packed = packFloat(data.value);
  } else if (typeof data === "bigint") {
    packed = packInt(data, null);
  } else if (typeof data === "number") {
    packed = Number.isInteger(data) && data >= 0 ? packInt(BigInt(data), null) : packFloat(data);
  } else if (typeof data === "string") {
    const encoded = Buffer.from(data, "utf-8");
    const len = encoded.length;
    if (len <= 0x20) packed = Buffer.concat([Buffer.from([0x40 + len]), encoded]);
    else if (len <= 0xff) packed = Buffer.concat([Buffer.from([0x61]), lenBytes(len, 1), encoded]);
    else if (len <= 0xffff) packed = Buffer.concat([Buffer.from([0x62]), lenBytes(len, 2), encoded]);
    else if (len <= 0xffffff) packed = Buffer.concat([Buffer.from([0x63]), lenBytes(len, 3), encoded]);
    else packed = Buffer.concat([Buffer.from([0x64]), lenBytes(len, 4), encoded]);
  } else if (data instanceof Uint8Array) {
    const len = data.length;
    if (len <= 0x20) packed = Buffer.concat([Buffer.from([0x70 + len]), data]);
    else if (len <= 0xff) packed = Buffer.concat([Buffer.from([0x91]), lenBytes(len, 1), data]);
    else if (len <= 0xffff) packed = Buffer.concat([Buffer.from([0x92]), lenBytes(len, 2), data]);
    else if (len <= 0xffffffff) packed = Buffer.concat([Buffer.from([0x93]), lenBytes(len, 4), data]);
    else packed = Buffer.concat([Buffer.from([0x94]), lenBytes(len, 8), data]);
  } else if (Array.isArray(data)) {
    const parts: Buffer[] = [Buffer.from([0xd0 + Math.min(data.length, 0xf)])];
    for (const item of data) parts.push(_pack(item, objectList));
    if (data.length >= 0xf) parts.push(Buffer.from([0x03]));
    packed = Buffer.concat(parts);
  } else if (data instanceof Map || (typeof data === "object" && data.constructor === Object)) {
    const entries: Array<[unknown, unknown]> =
      data instanceof Map ? [...data.entries()] : Object.entries(data as Record<string, unknown>);
    const parts: Buffer[] = [Buffer.from([0xe0 + Math.min(entries.length, 0xf)])];
    for (const [key, value] of entries) {
      parts.push(_pack(key, objectList));
      parts.push(_pack(value, objectList));
    }
    if (entries.length >= 0xf) parts.push(Buffer.from([0x03]));
    packed = Buffer.concat(parts);
  } else {
    throw new TypeError(String(typeof data === "object" ? data.constructor?.name : typeof data));
  }

  // Reuse if in object list, otherwise add it to list
  const key = packed.toString("latin1");
  const objectIndex = objectList.get(key);
  if (objectIndex !== undefined) {
    if (objectIndex < 0x21) packed = Buffer.from([0xa0 + objectIndex]);
    else if (objectIndex <= 0xff) packed = Buffer.concat([Buffer.from([0xc1]), intToBytes(objectIndex, 1, "little")]);
    else if (objectIndex <= 0xffff) packed = Buffer.concat([Buffer.from([0xc2]), intToBytes(objectIndex, 2, "little")]);
    else if (objectIndex <= 0xffffffff) packed = Buffer.concat([Buffer.from([0xc3]), intToBytes(objectIndex, 4, "little")]);
    else packed = Buffer.concat([Buffer.from([0xc4]), intToBytes(objectIndex, 8, "little")]);
  } else if (packed.length > 1) {
    objectList.set(key, objectList.size);
  }

  return packed;
}

function readUInt(data: Buffer, offset: number, size: number): number | bigint {
  let result = 0n;
  for (let i = size - 1; i >= 0; i--) result = (result << 8n) | BigInt(data[offset + i]!);
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : result;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (a instanceof Uint8Array && b instanceof Uint8Array) return Buffer.compare(a, b) === 0;
  if (a instanceof UUID) return a.equals(b);
  if (typeof a === "object") {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (a instanceof Map || b instanceof Map) return false;
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual((a as any)[k], (b as any)[k]));
  }
  return false;
}

/** Unpack raw OPACK data into JavaScript objects. Returns [value, remaining]. */
export function unpack(data: Uint8Array): [any, Buffer] {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const [value, offset] = _unpack(buf, 0, []);
  return [value, Buffer.from(buf.subarray(offset))];
}

function toDict(entries: Array<[unknown, unknown]>): Record<string, unknown> | Map<unknown, unknown> {
  if (entries.every(([key]) => typeof key === "string")) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of entries) out[key as string] = value;
    return out;
  }
  return new Map(entries);
}

function _unpack(data: Buffer, offset: number, objectList: unknown[]): [unknown, number] {
  let value: unknown;
  let next: number;
  let addToObjectList = true;
  const tag = data[offset];
  if (tag === undefined) throw new RangeError("not enough data");

  if (tag === 0x01) {
    [value, next, addToObjectList] = [true, offset + 1, false];
  } else if (tag === 0x02) {
    [value, next, addToObjectList] = [false, offset + 1, false];
  } else if (tag === 0x04) {
    [value, next, addToObjectList] = [null, offset + 1, false];
  } else if (tag === 0x05) {
    value = new UUID(data.subarray(offset + 1, offset + 17));
    next = offset + 17;
  } else if (tag === 0x06) {
    // TODO: Dummy implementation: only parse as integer
    value = readUInt(data, offset + 1, 8);
    next = offset + 9;
  } else if (tag >= 0x08 && tag <= 0x2f) {
    [value, next, addToObjectList] = [tag - 8, offset + 1, false];
  } else if (tag === 0x35) {
    value = data.readFloatLE(offset + 1);
    next = offset + 5;
  } else if (tag === 0x36) {
    value = data.readDoubleLE(offset + 1);
    next = offset + 9;
  } else if ((tag & 0xf0) === 0x30) {
    const noofBytes = 2 ** (tag & 0xf);
    value = readUInt(data, offset + 1, noofBytes);
    next = offset + 1 + noofBytes;
  } else if (tag >= 0x40 && tag <= 0x60) {
    const length = tag - 0x40;
    value = data.subarray(offset + 1, offset + 1 + length).toString("utf-8");
    next = offset + 1 + length;
  } else if (tag > 0x60 && tag <= 0x64) {
    const noofBytes = tag & 0xf;
    const length = Number(readUInt(data, offset + 1, noofBytes));
    const start = offset + 1 + noofBytes;
    value = data.subarray(start, start + length).toString("utf-8");
    next = start + length;
  } else if (tag >= 0x70 && tag <= 0x90) {
    const length = tag - 0x70;
    value = Buffer.from(data.subarray(offset + 1, offset + 1 + length));
    next = offset + 1 + length;
  } else if (tag >= 0x91 && tag <= 0x94) {
    const noofBytes = 1 << ((tag & 0xf) - 1);
    const length = Number(readUInt(data, offset + 1, noofBytes));
    const start = offset + 1 + noofBytes;
    value = Buffer.from(data.subarray(start, start + length));
    next = start + length;
  } else if ((tag & 0xf0) === 0xd0) {
    const count = tag & 0xf;
    const output: unknown[] = [];
    let ptr = offset + 1;
    if (count === 0xf) {
      // Endless list
      while (data[ptr] !== 0x03) {
        let item: unknown;
        [item, ptr] = _unpack(data, ptr, objectList);
        output.push(item);
      }
      ptr += 1;
    } else {
      for (let i = 0; i < count; i++) {
        let item: unknown;
        [item, ptr] = _unpack(data, ptr, objectList);
        output.push(item);
      }
    }
    [value, next, addToObjectList] = [output, ptr, false];
  } else if ((tag & 0xe0) === 0xe0) {
    const count = tag & 0xf;
    const entries: Array<[unknown, unknown]> = [];
    let ptr = offset + 1;
    if (count === 0xf) {
      // Endless dict
      while (data[ptr] !== 0x03) {
        let key: unknown;
        let item: unknown;
        [key, ptr] = _unpack(data, ptr, objectList);
        [item, ptr] = _unpack(data, ptr, objectList);
        entries.push([key, item]);
      }
      ptr += 1;
    } else {
      for (let i = 0; i < count; i++) {
        let key: unknown;
        let item: unknown;
        [key, ptr] = _unpack(data, ptr, objectList);
        [item, ptr] = _unpack(data, ptr, objectList);
        entries.push([key, item]);
      }
    }
    [value, next, addToObjectList] = [toDict(entries), ptr, false];
  } else if (tag >= 0xa0 && tag <= 0xc0) {
    value = objectList[tag - 0xa0];
    next = offset + 1;
  } else if (tag >= 0xc1 && tag <= 0xc4) {
    const length = tag - 0xc0;
    const uid = Number(readUInt(data, offset + 1, length));
    value = objectList[uid];
    next = offset + 1 + length;
  } else {
    throw new TypeError("0x" + tag.toString(16));
  }

  if (addToObjectList && !objectList.some((obj) => deepEqual(obj, value))) {
    objectList.push(value);
  }

  return [value, next];
}
