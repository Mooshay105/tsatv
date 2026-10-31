/** MRP server authentication code. */

import { randomBytes } from "node:crypto";
import { hkdfExpand } from "../../auth/hap_srp.ts";
import { ErrorCode, readTlv, TlvValue, writeTlv } from "../../auth/hap_tlv8.ts";
import { PIN_CODE, PRIVATE_KEY, SERVER_IDENTIFIER } from "../../auth/server_auth.ts";
import * as chacha20 from "../../support/chacha20.ts";
import { Ed25519PrivateKey, X25519PrivateKey, X25519PublicKey } from "../../support/crypto.ts";
import { logBinary } from "../../support/index.ts";
import { getLogger } from "../../support/logging.ts";
import { SRPContext, SRPServerSession } from "../../support/srp.ts";
import * as messages from "./messages.ts";
import * as pb from "./protobuf/index.ts";

const LOGGER = getLogger("pyatv.protocols.mrp.server_auth");

export interface ServerKeys {
  sign: Ed25519PrivateKey;
  auth: Buffer;
  authPub: Buffer;
  verify: X25519PrivateKey;
  verifyPub: Buffer;
}

/** Generate server encryption keys from seed. */
export function generateKeys(seed: Uint8Array): ServerKeys {
  const signingKey = Ed25519PrivateKey.fromPrivateBytes(seed);
  const verifyPrivate = X25519PrivateKey.fromPrivateBytes(seed);
  return {
    sign: signingKey,
    auth: signingKey.privateBytes(),
    authPub: signingKey.publicKey().publicBytes(),
    verify: verifyPrivate,
    verifyPub: verifyPrivate.publicKey().publicBytes(),
  };
}

/** Create SRP server session. Returns [session, salt]. */
export function newServerSession(keys: ServerKeys, pin: string | number): [SRPServerSession, Buffer] {
  const salt = randomBytes(16);
  const context = new SRPContext("Pair-Setup", String(pin));
  return [new SRPServerSession(context, salt, keys.auth), salt];
}

const byte = (value: number) => Buffer.from([value]);

/** Server-side implementation of MRP authentication. */
export abstract class MrpServerAuth {
  readonly uniqueId: Buffer;
  inputKey: Buffer | null = null;
  outputKey: Buffer | null = null;
  hasPaired = false;
  readonly keys: ServerKeys;
  session: SRPServerSession;
  salt: Buffer;

  constructor(
    readonly deviceName: string,
    uniqueId: string = SERVER_IDENTIFIER,
    pin: number = PIN_CODE,
  ) {
    this.uniqueId = Buffer.from(uniqueId);
    this.keys = generateKeys(PRIVATE_KEY);
    [this.session, this.salt] = newServerSession(this.keys, String(pin));
  }

  /** Handle received device information message. */
  handleDeviceInfo(message: pb.ProtocolMessage, _inner: unknown): void {
    LOGGER.debug("Received device info message");

    const resp = messages.create(pb.DEVICE_INFO_MESSAGE, 0, message.identifier);
    const inner = pb.extractInner(resp) as pb.DeviceInfoMessage;
    inner.uniqueIdentifier = this.uniqueId.toString("utf-8");
    inner.name = this.deviceName;
    inner.localizedModelName = this.deviceName;
    inner.systemBuildVersion = "17K449";
    inner.applicationBundleIdentifier = "com.apple.mediaremoted";
    inner.protocolVersion = 1;
    inner.lastSupportedMessageType = 77;
    inner.supportsSystemPairing = true;
    inner.allowsPairing = true;
    inner.systemMediaApplication = "com.apple.TVMusic";
    inner.supportsACL = true;
    inner.supportsSharedQueue = true;
    inner.supportsExtendedMotion = true;
    inner.sharedQueueVersion = 2;
    inner.deviceClass = 4;
    this.sendToClient(resp);
  }

  /** Handle incoming crypto pairing message. */
  handleCryptoPairing(_message: pb.ProtocolMessage, inner: pb.CryptoPairingMessage): void {
    LOGGER.debug("Received crypto pairing message");
    const pairingData = readTlv(inner.pairingData);
    const seqno = pairingData.get(TlvValue.SeqNo)![0]!;

    // Work-around for now to support "tries" to auth before pairing
    if (seqno === 1) {
      if (pairingData.has(TlvValue.PublicKey)) this.hasPaired = true;
      else if (pairingData.has(TlvValue.Method)) this.hasPaired = false;
    }

    const handler = `_m${seqno}${this.hasPaired ? "Verify" : "Setup"}` as const;
    (this as any)[handler](pairingData);
  }

  protected _m1Verify(pairingData: Map<number, Buffer>): void {
    const serverPubKey = this.keys.verifyPub;
    const clientPubKey = pairingData.get(TlvValue.PublicKey)!;

    const sharedKey = this.keys.verify.exchange(X25519PublicKey.fromPublicBytes(clientPubKey));
    const sessionKey = hkdfExpand("Pair-Verify-Encrypt-Salt", "Pair-Verify-Encrypt-Info", sharedKey);

    const info = Buffer.concat([serverPubKey, this.uniqueId, clientPubKey]);
    const signature = this.keys.sign.sign(info);

    const tlv = writeTlv(
      new Map([
        [TlvValue.Identifier, this.uniqueId],
        [TlvValue.Signature, signature],
      ]),
    );

    const chacha = new chacha20.Chacha20Cipher8byteNonce(sessionKey, sessionKey);
    const encrypted = chacha.encrypt(tlv, Buffer.from("PV-Msg02"));

    const msg = messages.cryptoPairing(
      new Map([
        [TlvValue.SeqNo, byte(0x02)],
        [TlvValue.PublicKey, serverPubKey],
        [TlvValue.EncryptedData, encrypted],
      ]),
    );

    this.outputKey = hkdfExpand("MediaRemote-Salt", "MediaRemote-Write-Encryption-Key", sharedKey);
    this.inputKey = hkdfExpand("MediaRemote-Salt", "MediaRemote-Read-Encryption-Key", sharedKey);

    logBinary(LOGGER, "Keys", { Output: this.outputKey, Input: this.inputKey });
    this.sendToClient(msg);
  }

  protected _m3Verify(_pairingData: Map<number, Buffer>): void {
    this.sendToClient(messages.cryptoPairing(new Map([[TlvValue.SeqNo, byte(0x04)]])));
    this.enableEncryption(this.inputKey!, this.outputKey!);
  }

  protected _m1Setup(_pairingData: Map<number, Buffer>): void {
    const msg = messages.cryptoPairing(
      new Map([
        [TlvValue.Salt, this.salt],
        [TlvValue.PublicKey, this.session.public],
        [TlvValue.SeqNo, byte(0x02)],
      ]),
    );
    this.sendToClient(msg);
  }

  protected _m3Setup(pairingData: Map<number, Buffer>): void {
    this.session.process(pairingData.get(TlvValue.PublicKey)!);

    let msg: pb.ProtocolMessage;
    if (this.session.verifyProof(pairingData.get(TlvValue.Proof)!)) {
      msg = messages.cryptoPairing(
        new Map([
          [TlvValue.Proof, this.session.keyProofHash],
          [TlvValue.SeqNo, byte(0x04)],
        ]),
      );
    } else {
      msg = messages.cryptoPairing(
        new Map([
          [TlvValue.Error, byte(ErrorCode.Authentication)],
          [TlvValue.SeqNo, byte(0x04)],
        ]),
      );
    }
    this.sendToClient(msg);
  }

  protected _m5Setup(_pairingData: Map<number, Buffer>): void {
    const sessionKey = hkdfExpand("Pair-Setup-Encrypt-Salt", "Pair-Setup-Encrypt-Info", this.session.key);
    const accDeviceX = hkdfExpand("Pair-Setup-Accessory-Sign-Salt", "Pair-Setup-Accessory-Sign-Info", this.session.key);

    const deviceInfo = Buffer.concat([accDeviceX, this.uniqueId, this.keys.authPub]);
    const signature = this.keys.sign.sign(deviceInfo);

    const tlv = writeTlv(
      new Map([
        [TlvValue.Identifier, this.uniqueId],
        [TlvValue.PublicKey, this.keys.authPub],
        [TlvValue.Signature, signature],
      ]),
    );

    const chacha = new chacha20.Chacha20Cipher8byteNonce(sessionKey, sessionKey);
    const encrypted = chacha.encrypt(tlv, Buffer.from("PS-Msg06"));

    const msg = messages.cryptoPairing(
      new Map([
        [TlvValue.SeqNo, byte(0x06)],
        [TlvValue.EncryptedData, encrypted],
      ]),
    );
    this.hasPaired = true;
    this.sendToClient(msg);
  }

  /** Send data to client device (iOS). */
  abstract sendToClient(message: pb.ProtocolMessage): void;

  /** Enable encryption with the specified keys. */
  abstract enableEncryption(outputKey: Uint8Array, inputKey: Uint8Array): void;
}
