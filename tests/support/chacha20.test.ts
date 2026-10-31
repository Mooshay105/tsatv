import { expect, test } from "bun:test";
import * as chacha20 from "../../src/support/chacha20.ts";
import { b } from "../utils.ts";

const fakeKey = b("k".repeat(32));

test("12 bytes nonce", () => {
  const cipher = new chacha20.Chacha20Cipher(fakeKey, fakeKey, 12);
  expect(cipher.outNonce.length).toBe(chacha20.NONCE_LENGTH);
  expect(cipher.inNonce.length).toBe(chacha20.NONCE_LENGTH);
  const result = cipher.encrypt(b("test"));
  expect(cipher.decrypt(result)).toEqual(b("test"));
});

test("8 bytes nonce", () => {
  const cipher = new chacha20.Chacha20Cipher8byteNonce(fakeKey, fakeKey);
  expect(cipher.outNonce.length).toBe(chacha20.NONCE_LENGTH);
  expect(cipher.inNonce.length).toBe(chacha20.NONCE_LENGTH);
  const result = cipher.encrypt(b("test"));
  expect(cipher.decrypt(result)).toEqual(b("test"));
});
