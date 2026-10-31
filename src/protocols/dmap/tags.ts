/** Util functions for extracting and constructing DMAP data. */

import * as plistlib from "../../support/plistlib.ts";

export type TagReader = ((data: Buffer, start: number, length: number) => unknown) & { tagType?: string };

function named(name: string, fn: (data: Buffer, start: number, length: number) => unknown): TagReader {
  const reader = fn as TagReader;
  reader.tagType = name;
  return reader;
}

/** Extract a string from a position in a sequence. */
export const readStr = named("str", (data, start, length) => data.subarray(start, start + length).toString("utf-8"));

/** Extract a uint from a position in a sequence. */
export const readUint = named("uint", (data, start, length) => {
  let result = 0n;
  for (const b of data.subarray(start, start + length)) result = (result << 8n) | BigInt(b);
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : result;
});

/** Extract a boolean from a position in a sequence. */
export const readBool = named("bool", (data, start, length) => readUint(data, start, length) === 1);

/** Extract a binary plist from a position in a sequence. */
export const readBplist = named("bplist", (data, start, length) => plistlib.loads(data.subarray(start, start + length)));

/** Extract binary data (in hex) from a position in a sequence. */
export const readBytes = named("bytes", (data, start, length) => "0x" + data.subarray(start, start + length).toString("hex"));

/** Use this to ignore data for all input. */
export const readIgnore = named("ignore", () => undefined);

function tagWithLength(name: string, value: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([Buffer.from(name, "utf-8"), length, value]);
}

function uintBytes(value: number | bigint, size: number): Buffer {
  const out = Buffer.alloc(size);
  let v = BigInt(value);
  for (let i = size - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Create a DMAP tag with uint8 data. */
export function uint8Tag(name: string, value: number | boolean): Buffer {
  return tagWithLength(name, uintBytes(Number(value), 1));
}

/** Create a DMAP tag with uint16 data. */
export function uint16Tag(name: string, value: number): Buffer {
  return tagWithLength(name, uintBytes(value, 2));
}

/** Create a DMAP tag with uint32 data. */
export function uint32Tag(name: string, value: number): Buffer {
  return tagWithLength(name, uintBytes(value, 4));
}

/** Create a DMAP tag with uint64 data. */
export function uint64Tag(name: string, value: number | bigint): Buffer {
  return tagWithLength(name, uintBytes(value, 8));
}

/** Create a DMAP tag with boolean data. */
export function boolTag(name: string, value: boolean): Buffer {
  return tagWithLength(name, Buffer.from([value ? 1 : 0]));
}

/** Create a DMAP tag with raw data. */
export function rawTag(name: string, value: Uint8Array): Buffer {
  return tagWithLength(name, value);
}

/** Create a DMAP tag with string data. */
export function stringTag(name: string, value: string): Buffer {
  return tagWithLength(name, Buffer.from(value, "utf-8"));
}

/** Create a DMAP container tag. */
export function containerTag(name: string, data: Uint8Array): Buffer {
  return rawTag(name, data); // Same as raw
}
