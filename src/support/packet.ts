/** Generic utility for encoding and decoding binary packets. */

import { calcsize, pack, unpack } from "./bytes.ts";

export interface PacketType<T> {
  readonly length: number;
  readonly fields: string[];
  decode(data: Uint8Array, allowExcessive?: boolean): T;
  encode(...args: any[]): Buffer;
  extend<E = Record<string, any>>(name: string, fields: Record<string, string>): PacketType<T & E>;
}

/** Define a protocol packet (fields map name -> struct format character). */
export function defpacket<T = Record<string, any>>(name: string, fields: Record<string, string>): PacketType<T> {
  const fmt = ">" + Object.values(fields).join("");
  const keys = Object.keys(fields);
  const length = calcsize(fmt);

  return {
    length,
    fields: keys,
    decode(data: Uint8Array, allowExcessive = false): T {
      const input = allowExcessive ? data.subarray(0, length) : data;
      if (!allowExcessive && input.length !== length) {
        throw new Error(`unpack requires a buffer of ${length} bytes`);
      }
      const values = unpack(fmt, input);
      const out: Record<string, any> = {};
      keys.forEach((key, i) => (out[key] = values[i]));
      return out as T;
    },
    encode(...args: any[]): Buffer {
      return pack(fmt, ...args);
    },
    extend<E>(extName: string, extFields: Record<string, string>): PacketType<T & E> {
      return defpacket<T & E>(extName, { ...fields, ...extFields });
    },
  };
}
