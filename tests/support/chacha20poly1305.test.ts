import { expect, test } from "bun:test";
import { ChaCha20Poly1305, InvalidTag, poly1305 } from "../../src/support/chacha20poly1305.ts";

// Test vectors from RFC 8439
test("rfc8439 aead vector", () => {
  const key = Buffer.from("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f", "hex");
  const nonce = Buffer.from("070000004041424344454647", "hex");
  const aad = Buffer.from("50515253c0c1c2c3c4c5c6c7", "hex");
  const plaintext = Buffer.from(
    "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
  );
  const cipher = new ChaCha20Poly1305(key);
  const encrypted = cipher.encrypt(nonce, plaintext, aad);
  expect(encrypted.subarray(-16).toString("hex")).toBe("1ae10b594f09e26a7e902ecbd0600691");
  expect(encrypted.subarray(0, 16).toString("hex")).toBe("d31a8d34648e60db7b86afbc53ef7ec2");
  expect(cipher.decrypt(nonce, encrypted, aad)).toEqual(plaintext);
});

test("rfc8439 poly1305 vector", () => {
  const key = Buffer.from("85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b", "hex");
  const tag = poly1305(key, Buffer.from("Cryptographic Forum Research Group"));
  expect(tag.toString("hex")).toBe("a8061dc1305136c6c22b8baf0c0127a9");
});

test("tampered data raises", () => {
  const cipher = new ChaCha20Poly1305(Buffer.alloc(32, 1));
  const nonce = Buffer.alloc(12);
  const encrypted = cipher.encrypt(nonce, Buffer.from("hello"));
  encrypted[0] = encrypted[0]! ^ 1;
  expect(() => cipher.decrypt(nonce, encrypted)).toThrow(InvalidTag);
});
