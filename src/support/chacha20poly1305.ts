/**
 * Pure TypeScript implementation of ChaCha20-Poly1305 (RFC 8439).
 *
 * Bun's crypto module (BoringSSL) does not expose chacha20-poly1305 via
 * createCipheriv, so this implementation is used instead.
 */

import { timingSafeEqual } from "node:crypto";

function rotl(v: number, c: number): number {
  return ((v << c) | (v >>> (32 - c))) >>> 0;
}

function quarterRound(s: Uint32Array, a: number, b: number, c: number, d: number): void {
  s[a] = (s[a]! + s[b]!) >>> 0;
  s[d] = rotl(s[d]! ^ s[a]!, 16);
  s[c] = (s[c]! + s[d]!) >>> 0;
  s[b] = rotl(s[b]! ^ s[c]!, 12);
  s[a] = (s[a]! + s[b]!) >>> 0;
  s[d] = rotl(s[d]! ^ s[a]!, 8);
  s[c] = (s[c]! + s[d]!) >>> 0;
  s[b] = rotl(s[b]! ^ s[c]!, 7);
}

function readU32(data: Uint8Array, offset: number): number {
  return (data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16) | (data[offset + 3]! << 24)) >>> 0;
}

const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];

function chachaBlock(key: Uint8Array, counter: number, nonce: Uint8Array, out: Uint8Array): void {
  const state = new Uint32Array(16);
  state[0] = SIGMA[0]!;
  state[1] = SIGMA[1]!;
  state[2] = SIGMA[2]!;
  state[3] = SIGMA[3]!;
  for (let i = 0; i < 8; i++) state[4 + i] = readU32(key, i * 4);
  state[12] = counter >>> 0;
  state[13] = readU32(nonce, 0);
  state[14] = readU32(nonce, 4);
  state[15] = readU32(nonce, 8);

  const working = new Uint32Array(state);
  for (let i = 0; i < 10; i++) {
    quarterRound(working, 0, 4, 8, 12);
    quarterRound(working, 1, 5, 9, 13);
    quarterRound(working, 2, 6, 10, 14);
    quarterRound(working, 3, 7, 11, 15);
    quarterRound(working, 0, 5, 10, 15);
    quarterRound(working, 1, 6, 11, 12);
    quarterRound(working, 2, 7, 8, 13);
    quarterRound(working, 3, 4, 9, 14);
  }
  for (let i = 0; i < 16; i++) {
    const v = (working[i]! + state[i]!) >>> 0;
    out[i * 4] = v & 0xff;
    out[i * 4 + 1] = (v >>> 8) & 0xff;
    out[i * 4 + 2] = (v >>> 16) & 0xff;
    out[i * 4 + 3] = (v >>> 24) & 0xff;
  }
}

/** Raw ChaCha20 stream cipher (XOR keystream starting at given block counter). */
export function chacha20(key: Uint8Array, nonce: Uint8Array, data: Uint8Array, counter = 1): Buffer {
  const out = Buffer.alloc(data.length);
  const block = new Uint8Array(64);
  for (let offset = 0; offset < data.length; offset += 64) {
    chachaBlock(key, counter++, nonce, block);
    const len = Math.min(64, data.length - offset);
    for (let i = 0; i < len; i++) out[offset + i] = data[offset + i]! ^ block[i]!;
  }
  return out;
}

const P1305 = (1n << 130n) - 5n;

function leBytesToBigInt(data: Uint8Array): bigint {
  let result = 0n;
  for (let i = data.length - 1; i >= 0; i--) result = (result << 8n) | BigInt(data[i]!);
  return result;
}

/** Poly1305 one-time authenticator. */
export function poly1305(key: Uint8Array, message: Uint8Array): Buffer {
  const r = leBytesToBigInt(key.subarray(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn;
  const s = leBytesToBigInt(key.subarray(16, 32));
  let acc = 0n;
  for (let offset = 0; offset < message.length; offset += 16) {
    const chunk = message.subarray(offset, Math.min(offset + 16, message.length));
    const n = leBytesToBigInt(chunk) + (1n << BigInt(8 * chunk.length));
    acc = ((acc + n) * r) % P1305;
  }
  acc = (acc + s) & ((1n << 128n) - 1n);
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number(acc & 0xffn);
    acc >>= 8n;
  }
  return out;
}

function pad16(length: number): Buffer {
  const rem = length % 16;
  return rem === 0 ? Buffer.alloc(0) : Buffer.alloc(16 - rem);
}

function macData(aad: Uint8Array, ciphertext: Uint8Array): Buffer {
  const lengths = Buffer.alloc(16);
  lengths.writeBigUInt64LE(BigInt(aad.length), 0);
  lengths.writeBigUInt64LE(BigInt(ciphertext.length), 8);
  return Buffer.concat([aad, pad16(aad.length), ciphertext, pad16(ciphertext.length), lengths]);
}

/** Raised when authentication tag does not match. */
export class InvalidTag extends Error {
  constructor() {
    super("invalid tag");
    this.name = "InvalidTag";
  }
}

/** AEAD ChaCha20-Poly1305 with an API similar to cryptography's. */
export class ChaCha20Poly1305 {
  private readonly key: Buffer;

  constructor(key: Uint8Array) {
    if (key.length !== 32) throw new RangeError("ChaCha20Poly1305 key must be 32 bytes");
    this.key = Buffer.from(key);
  }

  encrypt(nonce: Uint8Array, data: Uint8Array, aad?: Uint8Array | null): Buffer {
    if (nonce.length !== 12) throw new RangeError("nonce must be 12 bytes");
    const polyKey = chacha20(this.key, nonce, new Uint8Array(32), 0);
    const ciphertext = chacha20(this.key, nonce, data, 1);
    const tag = poly1305(polyKey, macData(aad ?? new Uint8Array(0), ciphertext));
    return Buffer.concat([ciphertext, tag]);
  }

  decrypt(nonce: Uint8Array, data: Uint8Array, aad?: Uint8Array | null): Buffer {
    if (nonce.length !== 12) throw new RangeError("nonce must be 12 bytes");
    if (data.length < 16) throw new InvalidTag();
    const ciphertext = data.subarray(0, data.length - 16);
    const tag = data.subarray(data.length - 16);
    const polyKey = chacha20(this.key, nonce, new Uint8Array(32), 0);
    const expected = poly1305(polyKey, macData(aad ?? new Uint8Array(0), ciphertext));
    if (!timingSafeEqual(expected, tag)) throw new InvalidTag();
    return chacha20(this.key, nonce, ciphertext, 1);
  }
}
