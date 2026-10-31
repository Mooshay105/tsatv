/** Minimal UUID value type. */

import { randomBytes } from "node:crypto";

export class UUID {
  readonly bytes: Buffer;

  constructor(value: string | Uint8Array) {
    if (typeof value === "string") {
      const hexStr = value.replace(/[{}-]/g, "").replace(/^urn:uuid:/i, "");
      if (!/^[0-9a-fA-F]{32}$/.test(hexStr)) throw new RangeError(`badly formed UUID: ${value}`);
      this.bytes = Buffer.from(hexStr, "hex");
    } else {
      if (value.length !== 16) throw new RangeError("UUID must be 16 bytes");
      this.bytes = Buffer.from(value);
    }
  }

  static uuid4(): UUID {
    const data = randomBytes(16);
    data[6] = (data[6]! & 0x0f) | 0x40;
    data[8] = (data[8]! & 0x3f) | 0x80;
    return new UUID(data);
  }

  get hex(): string {
    return this.bytes.toString("hex");
  }

  equals(other: unknown): boolean {
    return other instanceof UUID && other.bytes.equals(this.bytes);
  }

  toString(): string {
    const h = this.hex;
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
}

export function uuid4(): string {
  return UUID.uuid4().toString();
}
