/**
 * Parser and data extractor for raw DMAP data.
 *
 * DMAP is basically TLV where the key is a 4 byte ASCII value, a four byte big endian
 * unsigned int as length and the data as data.
 */

import { InvalidDmapDataError } from "../../exceptions.ts";
import { readBplist, readStr, readUint, type TagReader } from "./tags.ts";

/** Representation of a DMAP tag used when defining a protocol. */
export class DmapTag {
  constructor(
    readonly type: TagReader | "container",
    readonly name: string,
  ) {}

  toString(): string {
    const typeName = typeof this.type === "string" ? this.type : (this.type.tagType ?? "unknown");
    return `[${typeName}, ${this.name}]`;
  }
}

export type DmapData = Array<Record<string, unknown>>;
export type TagLookup = (name: string) => DmapTag;

function _parse(data: Buffer, dataLen: number, tagLookup: TagLookup, startPos: number): DmapData {
  const ctx: DmapData = [];
  let pos = startPos;
  while (pos < dataLen) {
    const fName = readStr(data, pos, 4) as string;
    const fLen = readUint(data, pos + 4, 4) as number;
    pos += 8;

    const tag = tagLookup(fName);
    if (tag.type === "container") {
      ctx.push({ [fName]: _parse(data, pos + fLen, tagLookup, pos) });
    } else {
      ctx.push({ [fName]: tag.type(data, pos, fLen) });
    }
    pos += fLen;
  }
  return ctx;
}

/** Parse raw DAAP data and returns it as an object. */
export function parse(data: Uint8Array, tagLookup: TagLookup): DmapData {
  const buf = Buffer.from(data);
  return _parse(buf, buf.length, tagLookup, 0);
}

/** Look up a value given a path in some parsed DMAP data. */
export function first(dmapData: unknown, ...path: string[]): any {
  if (!(path.length > 0 && Array.isArray(dmapData))) return dmapData;

  for (const key of dmapData as DmapData) {
    if (path[0]! in key) return first(key[path[0]!], ...path.slice(1));
  }
  return null;
}

function pyValue(value: unknown): string {
  if (value === true) return "True";
  if (value === false) return "False";
  if (value === null || value === undefined) return "None";
  return String(value);
}

/** Return a pretty formatted string of parsed DMAP data. */
export function pprint(data: unknown, tagLookup: TagLookup, indent = 0): string {
  let output = "";
  if (Array.isArray(data)) {
    for (const elem of data) output += pprint(elem, tagLookup, indent);
  } else if (data !== null && typeof data === "object" && !(data instanceof Uint8Array)) {
    for (const [key, value] of Object.entries(data)) {
      const tag = tagLookup(key);
      if (value !== null && typeof value === "object" && !(value instanceof Uint8Array) && tag.type !== readBplist) {
        output += " ".repeat(indent) + `${key}: ${tag}\n`;
        output += pprint(value, tagLookup, indent + 2);
      } else {
        output += " ".repeat(indent) + `${key}: ${pyValue(value)} ${tag}\n`;
      }
    }
  } else {
    throw new InvalidDmapDataError(`invalid dmap data: ${data}`);
  }
  return output;
}
