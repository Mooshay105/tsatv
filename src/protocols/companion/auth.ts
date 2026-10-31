/** Device pairing and derivation of encryption keys. */

import type { HapCredentials, PairSetupProcedure, PairVerifyProcedure } from "../../auth/hap_pairing.ts";
import type { SRPAuthHandler } from "../../auth/hap_srp.ts";
import { readTlv, stringify, TlvValue, writeTlv } from "../../auth/hap_tlv8.ts";
import { AuthenticationError, ProtocolError } from "../../exceptions.ts";
import { logBinary } from "../../support/index.ts";
import { getLogger } from "../../support/logging.ts";
import { FrameType } from "./connection.ts";
import type { CompanionProtocol } from "./protocol.ts";

const LOGGER = getLogger("pyatv.protocols.companion.auth");

export const PAIRING_DATA_KEY = "_pd";

const byte = (value: number) => Buffer.from([value]);

function getPairingData(message: Record<string, unknown>): Map<number, Buffer> {
  const pairingData = message[PAIRING_DATA_KEY];
  if (!pairingData || (Buffer.isBuffer(pairingData) && pairingData.length === 0)) {
    throw new AuthenticationError("no pairing data in message");
  }
  if (!Buffer.isBuffer(pairingData)) {
    throw new ProtocolError(`Pairing data has unexpected type: ${typeof pairingData}`);
  }

  const tlv = readTlv(pairingData);
  if (tlv.has(TlvValue.Error)) throw new AuthenticationError(stringify(tlv));
  return tlv;
}

/** Perform pairing and return new credentials. */
export class CompanionPairSetupProcedure implements PairSetupProcedure {
  private _atvSalt: Buffer | null = null;
  private _atvPubKey: Buffer | null = null;

  constructor(
    readonly protocol: CompanionProtocol,
    readonly srp: SRPAuthHandler,
  ) {}

  /** Start pairing procedure. */
  async startPairing(): Promise<void> {
    this.srp.initialize();
    await this.protocol.start();

    const resp = await this.protocol.exchangeAuth(FrameType.PS_Start, {
      [PAIRING_DATA_KEY]: writeTlv(
        new Map([
          [TlvValue.Method, byte(0x00)],
          [TlvValue.SeqNo, byte(0x01)],
        ]),
      ),
      _pwTy: 1,
    });

    const pairingData = getPairingData(resp);
    this._atvSalt = pairingData.get(TlvValue.Salt)!;
    this._atvPubKey = pairingData.get(TlvValue.PublicKey)!;
    logBinary(LOGGER, "Got pub key and salt", { Salt: this._atvSalt, PubKey: this._atvPubKey });
  }

  /** Finish pairing process. */
  async finishPairing(_username: string, pinCode: number | string, displayName: string | null): Promise<HapCredentials> {
    this.srp.step1(pinCode);

    const [pubKey, proof] = this.srp.step2(this._atvPubKey!, this._atvSalt!);

    let resp = await this.protocol.exchangeAuth(FrameType.PS_Next, {
      [PAIRING_DATA_KEY]: writeTlv(
        new Map([
          [TlvValue.SeqNo, byte(0x03)],
          [TlvValue.PublicKey, pubKey],
          [TlvValue.Proof, proof],
        ]),
      ),
      _pwTy: 1,
    });

    let pairingData = getPairingData(resp);
    const atvProof = pairingData.get(TlvValue.Proof);
    logBinary(LOGGER, "Device", { Proof: atvProof });

    const encryptedData = this.srp.step3(displayName);

    resp = await this.protocol.exchangeAuth(FrameType.PS_Next, {
      [PAIRING_DATA_KEY]: writeTlv(
        new Map([
          [TlvValue.SeqNo, byte(0x05)],
          [TlvValue.EncryptedData, encryptedData],
        ]),
      ),
      _pwTy: 1,
    });

    pairingData = getPairingData(resp);
    return this.srp.step4(pairingData.get(TlvValue.EncryptedData)!);
  }
}

/** Verify credentials and derive new encryption keys. */
export class CompanionPairVerifyProcedure implements PairVerifyProcedure {
  constructor(
    readonly protocol: CompanionProtocol,
    readonly srp: SRPAuthHandler,
    readonly credentials: HapCredentials,
  ) {}

  /** Verify credentials with device. */
  async verifyCredentials(): Promise<boolean> {
    const [, publicKey] = this.srp.initialize();

    const resp = await this.protocol.exchangeAuth(FrameType.PV_Start, {
      [PAIRING_DATA_KEY]: writeTlv(
        new Map([
          [TlvValue.SeqNo, byte(0x01)],
          [TlvValue.PublicKey, publicKey],
        ]),
      ),
      _auTy: 4,
    });

    const pairingData = getPairingData(resp);
    const serverPubKey = pairingData.get(TlvValue.PublicKey)!;
    const encrypted = pairingData.get(TlvValue.EncryptedData)!;
    logBinary(LOGGER, "Device", { Public: this.credentials.ltpk, Encrypted: encrypted });

    const encryptedData = this.srp.verify1(this.credentials, serverPubKey, encrypted);

    await this.protocol.exchangeAuth(FrameType.PV_Next, {
      [PAIRING_DATA_KEY]: writeTlv(
        new Map([
          [TlvValue.SeqNo, byte(0x03)],
          [TlvValue.EncryptedData, encryptedData],
        ]),
      ),
    });

    // TODO: check status code

    return true;
  }

  /** Return derived encryption keys. */
  encryptionKeys(salt: string, outputInfo: string, inputInfo: string): [Buffer, Buffer] {
    return this.srp.verify2(salt, outputInfo, inputInfo);
  }
}
