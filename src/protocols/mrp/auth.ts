/** Device pairing and derivation of encryption keys. */

import type { HapCredentials, PairSetupProcedure, PairVerifyProcedure } from "../../auth/hap_pairing.ts";
import type { SRPAuthHandler } from "../../auth/hap_srp.ts";
import { checkTlvError, readTlv, requireTlv, stringify, type TlvData, TlvValue } from "../../auth/hap_tlv8.ts";
import { AuthenticationError } from "../../exceptions.ts";
import { logBinary } from "../../support/index.ts";
import { getLogger } from "../../support/logging.ts";
import * as messages from "./messages.ts";
import * as pb from "./protobuf/index.ts";
import type { MrpProtocol } from "./protocol.ts";

const LOGGER = getLogger("pyatv.protocols.mrp.auth");

function getPairingData(resp: pb.ProtocolMessage): TlvData {
  const tlv = readTlv((pb.extractInner(resp) as pb.CryptoPairingMessage).pairingData);
  return checkTlvError(tlv);
}

const byte = (value: number) => Buffer.from([value]);

/** Perform pairing and return new credentials. */
export class MrpPairSetupProcedure implements PairSetupProcedure {
  private _atvSalt: Buffer | null = null;
  private _atvPubKey: Buffer | null = null;

  constructor(
    readonly protocol: MrpProtocol,
    readonly srp: SRPAuthHandler,
  ) {}

  /** Start pairing procedure. */
  async startPairing(): Promise<void> {
    this.srp.initialize();

    await this.protocol.start(true);

    const msg = messages.cryptoPairing(
      new Map([
        [TlvValue.Method, byte(0x00)],
        [TlvValue.SeqNo, byte(0x01)],
      ]),
      true,
    );
    const resp = await this.protocol.sendAndReceive(msg, false);

    const pairingData = getPairingData(resp);
    this._atvSalt = requireTlv(pairingData, TlvValue.Salt);
    this._atvPubKey = requireTlv(pairingData, TlvValue.PublicKey);
  }

  /** Finish pairing process. */
  async finishPairing(_username: string, pinCode: number | string, _displayName: string | null): Promise<HapCredentials> {
    this.srp.step1(pinCode);

    const [pubKey, proof] = this.srp.step2(this._atvPubKey!, this._atvSalt!);

    let msg = messages.cryptoPairing(
      new Map([
        [TlvValue.SeqNo, byte(0x03)],
        [TlvValue.PublicKey, pubKey],
        [TlvValue.Proof, proof],
      ]),
    );
    let resp = await this.protocol.sendAndReceive(msg, false);

    let pairingData = getPairingData(resp);
    const atvProof = pairingData.get(TlvValue.Proof);
    logBinary(LOGGER, "Device", { Proof: atvProof });

    let encryptedData = this.srp.step3();
    msg = messages.cryptoPairing(
      new Map([
        [TlvValue.SeqNo, byte(0x05)],
        [TlvValue.EncryptedData, encryptedData],
      ]),
    );
    resp = await this.protocol.sendAndReceive(msg, false);

    pairingData = getPairingData(resp);
    encryptedData = requireTlv(pairingData, TlvValue.EncryptedData);

    return this.srp.step4(encryptedData);
  }
}

/** Verify credentials and derive new encryption keys. */
export class MrpPairVerifyProcedure implements PairVerifyProcedure {
  constructor(
    readonly protocol: MrpProtocol,
    readonly srp: SRPAuthHandler,
    readonly credentials: HapCredentials,
  ) {}

  /** Verify credentials with device. */
  async verifyCredentials(): Promise<boolean> {
    const [, publicKey] = this.srp.initialize();

    let msg = messages.cryptoPairing(
      new Map([
        [TlvValue.SeqNo, byte(0x01)],
        [TlvValue.PublicKey, publicKey],
      ]),
    );
    const resp = getPairingData(await this.protocol.sendAndReceive(msg, false));

    const sessionPubKey = requireTlv(resp, TlvValue.PublicKey);
    const encrypted = requireTlv(resp, TlvValue.EncryptedData);
    logBinary(LOGGER, "Device", { Public: this.credentials.ltpk, Encrypted: encrypted });

    const encryptedData = this.srp.verify1(this.credentials, sessionPubKey, encrypted);
    msg = messages.cryptoPairing(
      new Map([
        [TlvValue.SeqNo, byte(0x03)],
        [TlvValue.EncryptedData, encryptedData],
      ]),
    );
    await this.protocol.sendAndReceive(msg, false);

    // TODO: check status code
    return true;
  }

  /** Return derived encryption keys. */
  encryptionKeys(salt: string, outputInfo: string, inputInfo: string): [Buffer, Buffer] {
    return this.srp.verify2(salt, outputInfo, inputInfo);
  }
}
