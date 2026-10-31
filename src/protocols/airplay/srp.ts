/** Implementation of SRP used by AirPlay device authentication. */

import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { HapCredentials } from "../../auth/hap_pairing.ts";
import { Ed25519PrivateKey, X25519PrivateKey, X25519PublicKey } from "../../support/crypto.ts";
import { logBinary } from "../../support/index.ts";
import { getLogger } from "../../support/logging.ts";
import { PRIME_2048, PRIME_2048_GEN, SRPClientSession, SRPContext } from "../../support/srp.ts";

const LOGGER = getLogger("pyatv.protocols.airplay.srp");

/** Create SHA512 hash for input arguments. */
export function hashSha512(...indata: Array<string | Uint8Array>): Buffer {
  const hasher = createHash("sha512");
  for (const data of indata) hasher.update(typeof data === "string" ? Buffer.from(data, "utf-8") : data);
  return hasher.digest();
}

/** Encrypt data with AES (CTR or GCM). Returns [last encrypted chunk, tag]. */
export function aesEncrypt(mode: "ctr" | "gcm", aesKey: Uint8Array, aesIv: Uint8Array, ...data: Uint8Array[]): [Buffer, Buffer | null] {
  const cipher = createCipheriv(mode === "ctr" ? "aes-128-ctr" : "aes-128-gcm", aesKey, aesIv);
  let result = Buffer.alloc(0);
  for (const value of data) result = cipher.update(value);
  cipher.final();
  return [result, mode === "gcm" ? (cipher as any).getAuthTag() : null];
}

/** Hooks replaceable in tests. */
export const airplaySrpHooks = {
  /** Generate a new identifier and seed for authentication. */
  newCredentials(): HapCredentials {
    // Auth here is technically not HAP, but it's close and for the sake of abstraction
    // HAP will be emulated. LTSK will hold the seed and client_id the identifier.
    return new HapCredentials(Buffer.alloc(0), randomBytes(32), Buffer.alloc(0), randomBytes(8));
  },
};

/** Generate a new identifier and seed for authentication. */
export function newCredentials(): HapCredentials {
  return airplaySrpHooks.newCredentials();
}

/** Custom session key used by Apple TV: K = H(S|0000) | H(S|0001). */
function atvSessionKey(ctx: SRPContext, premaster: bigint): Buffer {
  const s = ctx.premasterBytes(premaster);
  const k1 = ctx.hash(s, Buffer.from([0, 0, 0, 0]));
  const k2 = ctx.hash(s, Buffer.from([0, 0, 0, 1]));
  return Buffer.concat([k1, k2]);
}

/** Handle SRP data and crypto routines for auth and verification. */
export class LegacySRPAuthHandler {
  session: SRPClientSession | null = null;
  private _publicBytes: Buffer | null = null;
  private _authPrivate: Buffer | null = null;
  private _authPublic: Buffer | null = null;
  private _verifyPrivate: X25519PrivateKey | null = null;

  constructor(public credentials: HapCredentials) {}

  /** Initialize handler operation. */
  initialize(): void {
    const signingKey = Ed25519PrivateKey.fromPrivateBytes(this.credentials.ltsk);
    this._authPrivate = signingKey.privateBytes();
    this._authPublic = signingKey.publicKey().publicBytes();
    logBinary(LOGGER, "Authentication keys", { Private: this._authPrivate, Public: this._authPublic });
  }

  /** First device verification step. */
  verify1(): Buffer {
    this._verifyPrivate = X25519PrivateKey.fromPrivateBytes(this.credentials.ltsk);
    this._publicBytes = this._verifyPrivate.publicKey().publicBytes();
    logBinary(LOGGER, "Verification keys", { Private: this._verifyPrivate.privateBytes(), Public: this._publicBytes });
    return Buffer.concat([Buffer.from([1, 0, 0, 0]), this._publicBytes, this._authPublic!]);
  }

  /** Last device verification step. */
  verify2(atvPublicKey: Uint8Array, data: Uint8Array): Buffer {
    logBinary(LOGGER, "Verify", { PublicSecret: atvPublicKey, Data: data });

    // Generate a shared secret key
    const shared = this._verifyPrivate!.exchange(X25519PublicKey.fromPublicBytes(atvPublicKey));
    logBinary(LOGGER, "Shared secret", { Secret: shared });

    // Derive new AES key and IV from shared key
    const aesKey = hashSha512("Pair-Verify-AES-Key", shared).subarray(0, 16);
    const aesIv = hashSha512("Pair-Verify-AES-IV", shared).subarray(0, 16);
    logBinary(LOGGER, "Pair-Verify-AES", { Key: aesKey, IV: aesIv });

    // Sign public keys and encrypt with AES
    const signer = Ed25519PrivateKey.fromPrivateBytes(this._authPrivate!);
    const signed = signer.sign(Buffer.concat([this._publicBytes!, atvPublicKey]));
    const [signature] = aesEncrypt("ctr", aesKey, aesIv, data, signed);
    logBinary(LOGGER, "Signature", { Signature: signature });

    // Signature is prepended with 0x00000000 (alignment?)
    return Buffer.concat([Buffer.alloc(4), signature]);
  }

  /** First authentication step. */
  step1(username: string, password: string | number): void {
    const context = new SRPContext(String(username), String(password), PRIME_2048, PRIME_2048_GEN, "sha1", {
      compat: "srptools",
      sessionKey: atvSessionKey,
    });
    this.session = new SRPClientSession(context, this._authPrivate!);
  }

  /** Second authentication step. Returns [client public, proof]. */
  step2(pubKey: Uint8Array, salt: Uint8Array): [Buffer, Buffer] {
    this.session!.process(pubKey, salt);
    const clientPublic = this.session!.public;
    const proof = this.session!.keyProof;
    LOGGER.debug("Client public: %s, proof: %s", clientPublic.toString("hex"), proof.toString("hex"));
    return [clientPublic, proof];
  }

  /** Last authentication step. Returns [epk, tag]. */
  step3(): [Buffer, Buffer] {
    const sessionKey = this.session!.key;

    const aesKey = hashSha512("Pair-Setup-AES-Key", sessionKey).subarray(0, 16);
    const tmp = Buffer.from(hashSha512("Pair-Setup-AES-IV", sessionKey).subarray(0, 16));
    LOGGER.debug("Increase last byte from %d to %s", tmp[15], tmp[15]! + 1);
    tmp[15] = (tmp[15]! + 1) & 0xff; // Last byte must be increased by 1
    logBinary(LOGGER, "Pair-Setup-AES", { Key: aesKey, IV: tmp });

    const [epk, tag] = aesEncrypt("gcm", aesKey, tmp, this._authPublic!);
    logBinary(LOGGER, "Pair-Setup EPK+Tag", { EPK: epk, Tag: tag });
    return [epk, tag!];
  }
}
