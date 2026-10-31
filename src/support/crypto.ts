/** Thin helpers around node:crypto for raw Ed25519/X25519 keys and HKDF. */

import crypto from "node:crypto";

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

function privateKey(prefix: Buffer, raw: Uint8Array): crypto.KeyObject {
  if (raw.length !== 32) throw new RangeError("private key must be 32 bytes");
  return crypto.createPrivateKey({ key: Buffer.concat([prefix, raw]), format: "der", type: "pkcs8" });
}

function publicKey(prefix: Buffer, raw: Uint8Array): crypto.KeyObject {
  if (raw.length !== 32) throw new RangeError("public key must be 32 bytes");
  return crypto.createPublicKey({ key: Buffer.concat([prefix, raw]), format: "der", type: "spki" });
}

function rawPublic(key: crypto.KeyObject): Buffer {
  const der = crypto.createPublicKey(key).export({ format: "der", type: "spki" });
  return Buffer.from(der.subarray(der.length - 32));
}

export class InvalidSignature extends Error {
  constructor() {
    super("invalid signature");
    this.name = "InvalidSignature";
  }
}

/** Ed25519 private key based on a raw 32 byte seed. */
export class Ed25519PrivateKey {
  private readonly key: crypto.KeyObject;
  readonly seed: Buffer;

  constructor(seed: Uint8Array) {
    this.seed = Buffer.from(seed);
    this.key = privateKey(ED25519_PKCS8_PREFIX, seed);
  }

  static generate(): Ed25519PrivateKey {
    return new Ed25519PrivateKey(crypto.randomBytes(32));
  }

  static fromPrivateBytes(seed: Uint8Array): Ed25519PrivateKey {
    return new Ed25519PrivateKey(seed);
  }

  privateBytes(): Buffer {
    return Buffer.from(this.seed);
  }

  publicKey(): Ed25519PublicKey {
    return new Ed25519PublicKey(rawPublic(this.key));
  }

  sign(data: Uint8Array): Buffer {
    return crypto.sign(null, data, this.key);
  }
}

/** Ed25519 public key (raw 32 bytes). */
export class Ed25519PublicKey {
  readonly raw: Buffer;
  private readonly key: crypto.KeyObject;

  constructor(raw: Uint8Array) {
    this.raw = Buffer.from(raw);
    this.key = publicKey(ED25519_SPKI_PREFIX, raw);
  }

  static fromPublicBytes(raw: Uint8Array): Ed25519PublicKey {
    return new Ed25519PublicKey(raw);
  }

  publicBytes(): Buffer {
    return Buffer.from(this.raw);
  }

  /** Verify signature, raises InvalidSignature if not valid. */
  verify(signature: Uint8Array, data: Uint8Array): void {
    let valid = false;
    try {
      valid = crypto.verify(null, data, this.key, signature);
    } catch {
      valid = false;
    }
    if (!valid) throw new InvalidSignature();
  }
}

/** X25519 private key (raw 32 bytes). */
export class X25519PrivateKey {
  private readonly key: crypto.KeyObject;
  readonly raw: Buffer;

  constructor(raw: Uint8Array) {
    this.raw = Buffer.from(raw);
    this.key = privateKey(X25519_PKCS8_PREFIX, raw);
  }

  static generate(): X25519PrivateKey {
    return new X25519PrivateKey(crypto.randomBytes(32));
  }

  static fromPrivateBytes(raw: Uint8Array): X25519PrivateKey {
    return new X25519PrivateKey(raw);
  }

  privateBytes(): Buffer {
    return Buffer.from(this.raw);
  }

  publicKey(): X25519PublicKey {
    return new X25519PublicKey(rawPublic(this.key));
  }

  exchange(peer: X25519PublicKey): Buffer {
    return crypto.diffieHellman({ privateKey: this.key, publicKey: peer.keyObject });
  }
}

/** X25519 public key (raw 32 bytes). */
export class X25519PublicKey {
  readonly raw: Buffer;
  readonly keyObject: crypto.KeyObject;

  constructor(raw: Uint8Array) {
    this.raw = Buffer.from(raw);
    this.keyObject = publicKey(X25519_SPKI_PREFIX, raw);
  }

  static fromPublicBytes(raw: Uint8Array): X25519PublicKey {
    return new X25519PublicKey(raw);
  }

  publicBytes(): Buffer {
    return Buffer.from(this.raw);
  }
}

/** HKDF (SHA512) deriving a key of given length. */
export function hkdf(salt: Uint8Array | string, info: Uint8Array | string, secret: Uint8Array, length = 32, hash = "sha512"): Buffer {
  return Buffer.from(crypto.hkdfSync(hash, secret, salt, info, length));
}
