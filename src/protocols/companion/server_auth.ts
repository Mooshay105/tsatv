/** Companion+ server authentication code. */

import { hkdfExpand } from "../../auth/hap_srp.ts";
import { ErrorCode, readTlv, TlvValue, writeTlv } from "../../auth/hap_tlv8.ts";
import { PIN_CODE, PRIVATE_KEY, SERVER_IDENTIFIER } from "../../auth/server_auth.ts";
import * as chacha20 from "../../support/chacha20.ts";
import { X25519PublicKey } from "../../support/crypto.ts";
import { logBinary } from "../../support/index.ts";
import { getLogger } from "../../support/logging.ts";
import * as opack from "../../support/opack.ts";
import type { SRPServerSession } from "../../support/srp.ts";
import { generateKeys, newServerSession, type ServerKeys } from "../mrp/server_auth.ts";
import { FrameType } from "./connection.ts";

const LOGGER = getLogger("pyatv.protocols.companion.server_auth");

const byte = (value: number) => Buffer.from([value]);

/** Server-side implementation of Companion authentication. */
export abstract class CompanionServerAuth {
  readonly uniqueId: Buffer;
  inputKey: Buffer | null = null;
  outputKey: Buffer | null = null;
  readonly keys: ServerKeys;
  session: SRPServerSession;
  salt: Buffer;

  constructor(
    readonly deviceName: string,
    uniqueId: string = SERVER_IDENTIFIER,
    _pin: number = PIN_CODE,
  ) {
    this.uniqueId = Buffer.from(uniqueId);
    this.keys = generateKeys(PRIVATE_KEY);
    // NB: pyatv always uses PIN_CODE here (not the pin argument)
    [this.session, this.salt] = newServerSession(this.keys, String(PIN_CODE));
  }

  /** Handle incoming auth message. */
  handleAuthFrame(frameType: FrameType, data: Record<string, any>): void {
    LOGGER.debug("Received auth frame: type=%s, data=%s", FrameType[frameType], data);
    const pairingData = readTlv(data._pd);
    const seqno = pairingData.get(TlvValue.SeqNo)!.readUIntLE(0, pairingData.get(TlvValue.SeqNo)!.length);

    const suffix = frameType === FrameType.PV_Start || frameType === FrameType.PV_Next ? "Verify" : "Setup";
    (this as any)[`_m${seqno}${suffix}`](pairingData);
  }

  protected _m1Verify(pairingData: Map<number, Buffer>): void {
    const serverPubKey = this.keys.verifyPub;
    const clientPubKey = pairingData.get(TlvValue.PublicKey)!;

    const sharedKey = this.keys.verify.exchange(X25519PublicKey.fromPublicBytes(clientPubKey));
    const sessionKey = hkdfExpand("Pair-Verify-Encrypt-Salt", "Pair-Verify-Encrypt-Info", sharedKey);

    const info = Buffer.concat([serverPubKey, this.uniqueId, clientPubKey]);
    const signature = this.keys.sign.sign(info);

    const inner = writeTlv(
      new Map([
        [TlvValue.Identifier, this.uniqueId],
        [TlvValue.Signature, signature],
      ]),
    );

    const chacha = new chacha20.Chacha20Cipher(sessionKey, sessionKey);
    const encrypted = chacha.encrypt(inner, Buffer.from("PV-Msg02"));

    const tlv = writeTlv(
      new Map([
        [TlvValue.SeqNo, byte(0x02)],
        [TlvValue.PublicKey, serverPubKey],
        [TlvValue.EncryptedData, encrypted],
      ]),
    );

    this.outputKey = hkdfExpand("", "ServerEncrypt-main", sharedKey);
    this.inputKey = hkdfExpand("", "ClientEncrypt-main", sharedKey);

    logBinary(LOGGER, "Keys", { Output: this.outputKey, Input: this.inputKey });

    this.sendToClient(FrameType.PV_Next, { _pd: tlv });
  }

  protected _m3Verify(_pairingData: Map<number, Buffer>): void {
    this.sendToClient(FrameType.PV_Next, { _pd: writeTlv(new Map([[TlvValue.SeqNo, byte(0x04)]])) });
    this.enableEncryption(this.outputKey!, this.inputKey!);
  }

  protected _m1Setup(_pairingData: Map<number, Buffer>): void {
    const tlv = writeTlv(
      new Map<number, Buffer>([
        [TlvValue.SeqNo, byte(0x02)],
        [TlvValue.Salt, this.salt],
        [TlvValue.PublicKey, this.session.public],
        [27, byte(0x01)],
      ]),
    );
    this.sendToClient(FrameType.PS_Next, { _pd: tlv, _pwTy: 1 });
  }

  protected _m3Setup(pairingData: Map<number, Buffer>): void {
    this.session.process(pairingData.get(TlvValue.PublicKey)!);

    let tlv: Map<number, Buffer>;
    if (this.session.verifyProof(pairingData.get(TlvValue.Proof)!)) {
      tlv = new Map([
        [TlvValue.Proof, this.session.keyProofHash],
        [TlvValue.SeqNo, byte(0x04)],
      ]);
    } else {
      tlv = new Map([
        [TlvValue.Error, byte(ErrorCode.Authentication)],
        [TlvValue.SeqNo, byte(0x04)],
      ]);
    }
    this.sendToClient(FrameType.PS_Next, { _pd: writeTlv(tlv) });
  }

  protected _m5Setup(pairingData: Map<number, Buffer>): void {
    const sessionKey = hkdfExpand("Pair-Setup-Encrypt-Salt", "Pair-Setup-Encrypt-Info", this.session.key);
    const accDeviceX = hkdfExpand("Pair-Setup-Accessory-Sign-Salt", "Pair-Setup-Accessory-Sign-Info", this.session.key);

    const chacha = new chacha20.Chacha20Cipher(sessionKey, sessionKey);
    const decrypted = chacha.decrypt(pairingData.get(TlvValue.EncryptedData)!, Buffer.from("PS-Msg05"));
    LOGGER.debug("MSG5 EncryptedData=%s", readTlv(decrypted));

    const other = {
      altIRK: Buffer.from("2d54e07a882a656e11ab82762d2725c5", "hex"),
      accountID: "DC6A7CB6-CA1A-4BF4-880D-A61B717814DB",
      model: "AppleTV6,2",
      wifiMAC: Buffer.from("40ffa18fa1b9", "hex"),
      name: "Living Room",
      mac: Buffer.from("40c4ff8fb199", "hex"),
    };

    const deviceInfo = Buffer.concat([accDeviceX, this.uniqueId, this.keys.authPub]);
    const signature = this.keys.sign.sign(deviceInfo);

    const inner = writeTlv(
      new Map<number, Buffer>([
        [TlvValue.Identifier, this.uniqueId],
        [TlvValue.PublicKey, this.keys.authPub],
        [TlvValue.Signature, signature],
        [17, opack.pack(other)],
      ]),
    );

    const encrypted = new chacha20.Chacha20Cipher(sessionKey, sessionKey).encrypt(inner, Buffer.from("PS-Msg06"));
    const tlv = writeTlv(
      new Map([
        [TlvValue.SeqNo, byte(0x06)],
        [TlvValue.EncryptedData, encrypted],
      ]),
    );

    this.sendToClient(FrameType.PS_Next, { _pd: tlv });
    this.hasPaired();
  }

  /** Send data to client device (iOS). */
  abstract sendToClient(frameType: FrameType, data: Record<string, unknown>): void;

  /** Enable encryption with the specified keys. */
  abstract enableEncryption(outputKey: Uint8Array, inputKey: Uint8Array): void;

  /** Call when a client has paired. */
  hasPaired(): void {}
}
