/** API for performing and verifying device authentication. */

import type { HapCredentials, PairSetupProcedure, PairVerifyProcedure } from "../../../auth/hap_pairing.ts";
import type { SRPAuthHandler } from "../../../auth/hap_srp.ts";
import { checkTlvError, readTlv, requireTlv, type TlvData, TlvValue, writeTlv } from "../../../auth/hap_tlv8.ts";
import { InvalidResponseError } from "../../../exceptions.ts";
import type { HttpConnection, HttpResponse } from "../../../support/http.ts";
import { logBinary } from "../../../support/index.ts";
import { getLogger } from "../../../support/logging.ts";

const LOGGER = getLogger("pyatv.protocols.airplay.auth.hap");

const AIRPLAY_HEADERS = {
  "User-Agent": "AirPlay/320.20",
  Connection: "keep-alive",
  "X-Apple-HKP": 3,
  "Content-Type": "application/octet-stream",
};

const byte = (value: number) => Buffer.from([value]);

export function getPairingData(resp: HttpResponse): TlvData {
  if (!Buffer.isBuffer(resp.body)) throw new InvalidResponseError(`got unexpected response: ${resp.body}`);
  return checkTlvError(readTlv(resp.body));
}

/** Authenticate a device for AirPlay playback. */
export class AirPlayHapPairSetupProcedure implements PairSetupProcedure {
  private _atvSalt: Buffer | null = null;
  private _atvPubKey: Buffer | null = null;

  constructor(
    readonly http: HttpConnection,
    readonly srp: SRPAuthHandler,
  ) {}

  /** Start the authentication process. This method will show the expected PIN on screen. */
  async startPairing(): Promise<void> {
    this.srp.initialize();
    await this.http.post("/pair-pin-start", { headers: AIRPLAY_HEADERS });

    const data = new Map([
      [TlvValue.Method, byte(0x00)],
      [TlvValue.SeqNo, byte(0x01)],
    ]);
    const resp = await this.http.post("/pair-setup", { body: writeTlv(data), headers: AIRPLAY_HEADERS });
    const pairingData = getPairingData(resp);
    this._atvSalt = requireTlv(pairingData, TlvValue.Salt);
    this._atvPubKey = requireTlv(pairingData, TlvValue.PublicKey);
  }

  /** Finish authentication process. */
  async finishPairing(_username: string, pinCode: number | string, displayName: string | null): Promise<HapCredentials> {
    this.srp.step1(pinCode);

    const [pubKey, proof] = this.srp.step2(this._atvPubKey!, this._atvSalt!);
    await this.http.post("/pair-setup", {
      body: writeTlv(
        new Map([
          [TlvValue.SeqNo, byte(0x03)],
          [TlvValue.PublicKey, pubKey],
          [TlvValue.Proof, proof],
        ]),
      ),
      headers: AIRPLAY_HEADERS,
    });

    const resp = await this.http.post("/pair-setup", {
      body: writeTlv(
        new Map([
          [TlvValue.SeqNo, byte(0x05)],
          [TlvValue.EncryptedData, this.srp.step3(displayName)],
        ]),
      ),
      headers: AIRPLAY_HEADERS,
    });
    const pairingData = getPairingData(resp);
    return this.srp.step4(requireTlv(pairingData, TlvValue.EncryptedData));
  }
}

/** Verify if a device is allowed to perform AirPlay playback. */
export class AirPlayHapPairVerifyProcedure implements PairVerifyProcedure {
  constructor(
    readonly http: HttpConnection,
    readonly srp: SRPAuthHandler,
    readonly credentials: HapCredentials,
  ) {}

  /** Verify if device is allowed to use AirPlay. */
  async verifyCredentials(): Promise<boolean> {
    const [, publicKey] = this.srp.initialize();

    const resp = await this._send(
      new Map([
        [TlvValue.SeqNo, byte(0x01)],
        [TlvValue.PublicKey, publicKey],
      ]),
    );

    const pairingData = getPairingData(resp);
    const sessionPubKey = requireTlv(pairingData, TlvValue.PublicKey);
    const encrypted = requireTlv(pairingData, TlvValue.EncryptedData);
    logBinary(LOGGER, "Device", { Public: this.credentials.ltpk, Encrypted: encrypted });

    const encryptedData = this.srp.verify1(this.credentials, sessionPubKey, encrypted);
    await this._send(
      new Map([
        [TlvValue.SeqNo, byte(0x03)],
        [TlvValue.EncryptedData, encryptedData],
      ]),
    );

    // TODO: check status code
    return true;
  }

  private _send(data: Map<number, Buffer>): Promise<HttpResponse> {
    return this.http.post("/pair-verify", { body: writeTlv(data), headers: AIRPLAY_HEADERS });
  }

  /** Return derived encryption keys. */
  encryptionKeys(salt: string, outputInfo: string, inputInfo: string): [Buffer, Buffer] {
    return this.srp.verify2(salt, outputInfo, inputInfo);
  }
}
