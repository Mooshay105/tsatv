/** SRP implementation for HAP. */

import { randomBytes } from "node:crypto";
import { AuthenticationError } from "../exceptions.ts";
import * as chacha20 from "../support/chacha20.ts";
import {
  Ed25519PrivateKey,
  Ed25519PublicKey,
  hkdf,
  InvalidSignature,
  X25519PrivateKey,
  X25519PublicKey,
} from "../support/crypto.ts";
import { logBinary } from "../support/index.ts";
import { getLogger } from "../support/logging.ts";
import * as opack from "../support/opack.ts";
import { SRPClientSession, SRPContext } from "../support/srp.ts";
import { uuid4 } from "../support/uuid.ts";
import { HapCredentials } from "./hap_pairing.ts";
import { readTlv, TlvValue, writeTlv } from "./hap_tlv8.ts";

const LOGGER = getLogger("pyatv.auth.hap_srp");

/** Derive encryption keys from shared secret. */
export function hkdfExpand(salt: string, info: string, sharedSecret: Uint8Array): Buffer {
  return hkdf(Buffer.from(salt), Buffer.from(info), sharedSecret, 32, "sha512");
}

/** Hooks that can be replaced in tests (e.g. to use deterministic values). */
export const srpHooks = {
  randomBytes: (n: number): Buffer => randomBytes(n),
  pairingId: (): Buffer => Buffer.from(uuid4()),
};

/** Handle SRP crypto routines for auth and key derivation. */
export class SRPAuthHandler {
  pairingId: Buffer;
  private _signingKey: Ed25519PrivateKey | null = null;
  private _authPrivate: Buffer | null = null;
  private _authPublic: Buffer | null = null;
  private _verifyPrivate: X25519PrivateKey | null = null;
  private _publicBytes: Buffer | null = null;
  private _session: SRPClientSession | null = null;
  private _shared: Buffer | null = null;
  private _sessionKey: Buffer | null = null;

  constructor() {
    this.pairingId = srpHooks.pairingId();
  }

  /** Return shared secret (SRP session key). */
  get sharedKey(): Buffer {
    if (!this._session) throw new Error("no session");
    return this._session.key;
  }

  /** Initialize operation by generating new keys. Returns [auth public, verify public]. */
  initialize(): [Buffer, Buffer] {
    this._signingKey = Ed25519PrivateKey.fromPrivateBytes(srpHooks.randomBytes(32));
    this._authPrivate = this._signingKey.privateBytes();
    this._authPublic = this._signingKey.publicKey().publicBytes();
    this._verifyPrivate = X25519PrivateKey.fromPrivateBytes(srpHooks.randomBytes(32));
    this._publicBytes = this._verifyPrivate.publicKey().publicBytes();
    return [this._authPublic, this._publicBytes];
  }

  /** First verification step. */
  verify1(credentials: HapCredentials, sessionPubKey: Uint8Array, encrypted: Uint8Array): Buffer {
    this._shared = this._verifyPrivate!.exchange(X25519PublicKey.fromPublicBytes(sessionPubKey));

    const sessionKey = hkdfExpand("Pair-Verify-Encrypt-Salt", "Pair-Verify-Encrypt-Info", this._shared);

    const chacha = new chacha20.Chacha20Cipher8byteNonce(sessionKey, sessionKey);
    const decryptedTlv = readTlv(chacha.decrypt(encrypted, Buffer.from("PV-Msg02")));

    const identifier = decryptedTlv.get(TlvValue.Identifier);
    const signature = decryptedTlv.get(TlvValue.Signature);

    if (!identifier || !identifier.equals(credentials.atvId)) {
      throw new AuthenticationError("incorrect device response");
    }

    const info = Buffer.concat([sessionPubKey, identifier, this._publicBytes!]);
    const ltpk = Ed25519PublicKey.fromPublicBytes(credentials.ltpk);

    try {
      ltpk.verify(signature ?? Buffer.alloc(0), info);
    } catch (ex) {
      if (ex instanceof InvalidSignature) throw new AuthenticationError("signature error", { cause: ex });
      throw ex;
    }

    const deviceInfo = Buffer.concat([this._publicBytes!, credentials.clientId, sessionPubKey]);
    const deviceSignature = Ed25519PrivateKey.fromPrivateBytes(credentials.ltsk).sign(deviceInfo);

    const tlv = writeTlv(
      new Map([
        [TlvValue.Identifier, credentials.clientId],
        [TlvValue.Signature, deviceSignature],
      ]),
    );

    return chacha.encrypt(tlv, Buffer.from("PV-Msg03"));
  }

  /** Last verification step. The derived keys (output, input) are returned here. */
  verify2(salt: string, outputInfo: string, inputInfo: string): [Buffer, Buffer] {
    const outputKey = hkdfExpand(salt, outputInfo, this._shared!);
    const inputKey = hkdfExpand(salt, inputInfo, this._shared!);
    logBinary(LOGGER, "Keys", { Output: outputKey, Input: inputKey });
    return [outputKey, inputKey];
  }

  /** First pairing step. */
  step1(pin: number | string): void {
    const context = new SRPContext("Pair-Setup", String(pin));
    this._session = new SRPClientSession(context, this._authPrivate!);
  }

  /** Second pairing step. Returns [public key, proof]. */
  step2(atvPubKey: Uint8Array, atvSalt: Uint8Array): [Buffer, Buffer] {
    this._session!.process(atvPubKey, atvSalt);
    const pubKey = this._session!.public;
    const proof = this._session!.keyProof;
    logBinary(LOGGER, "Client", { Public: pubKey, Proof: proof });
    return [pubKey, proof];
  }

  /** Verify proof from device (M4). */
  verifyServerProof(proof: Uint8Array): boolean {
    return this._session!.verifyProof(proof);
  }

  /** Third pairing step. */
  step3(name: string | null = null, additionalData: Map<number, Buffer> | null = null): Buffer {
    const sessionKey = this._session!.key;
    const iosDeviceX = hkdfExpand("Pair-Setup-Controller-Sign-Salt", "Pair-Setup-Controller-Sign-Info", sessionKey);

    this._sessionKey = hkdfExpand("Pair-Setup-Encrypt-Salt", "Pair-Setup-Encrypt-Info", sessionKey);

    const deviceInfo = Buffer.concat([iosDeviceX, this.pairingId, this._authPublic!]);
    const deviceSignature = this._signingKey!.sign(deviceInfo);

    const tlv = new Map<number, Buffer>([
      [TlvValue.Identifier, this.pairingId],
      [TlvValue.PublicKey, this._authPublic!],
      [TlvValue.Signature, deviceSignature],
    ]);

    if (name) {
      tlv.set(TlvValue.Name, opack.pack({ name }));
    }

    if (additionalData) {
      for (const [key, value] of additionalData) tlv.set(key, value);
    }

    const chacha = new chacha20.Chacha20Cipher8byteNonce(this._sessionKey, this._sessionKey);
    const encryptedData = chacha.encrypt(writeTlv(tlv), Buffer.from("PS-Msg05"));
    logBinary(LOGGER, "Data", { Encrypted: encryptedData });
    return encryptedData;
  }

  /** Last pairing step. */
  step4(encryptedData: Uint8Array): HapCredentials {
    const chacha = new chacha20.Chacha20Cipher8byteNonce(this._sessionKey!, this._sessionKey!);
    let decryptedTlvBytes: Buffer;
    try {
      decryptedTlvBytes = chacha.decrypt(encryptedData, Buffer.from("PS-Msg06"));
    } catch (ex) {
      throw new AuthenticationError("data decrypt failed", { cause: ex });
    }

    if (decryptedTlvBytes.length === 0) {
      throw new AuthenticationError("data decrypt failed");
    }

    const decryptedTlv = readTlv(decryptedTlvBytes);
    LOGGER.debug("PS-Msg06: %s", decryptedTlv);

    const atvIdentifier = decryptedTlv.get(TlvValue.Identifier)!;
    const atvSignature = decryptedTlv.get(TlvValue.Signature);
    const atvPubKey = decryptedTlv.get(TlvValue.PublicKey)!;
    logBinary(LOGGER, "Device", { Identifier: atvIdentifier, Signature: atvSignature, Public: atvPubKey });

    // TODO: verify signature here

    return new HapCredentials(atvPubKey, this._authPrivate!, atvIdentifier, this.pairingId);
  }
}
