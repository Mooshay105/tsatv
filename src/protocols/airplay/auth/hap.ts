/** API for performing and verifying device authentication. */

import type { HapCredentials, PairSetupProcedure, PairVerifyProcedure } from "../../../auth/hap_pairing.ts";
import type { SRPAuthHandler } from "../../../auth/hap_srp.ts";
import { checkTlvError, readTlv, requireTlv, type TlvData, TlvValue, writeTlv } from "../../../auth/hap_tlv8.ts";
import { InvalidResponseError } from "../../../exceptions.ts";
import type { HeaderValue, HttpConnection, HttpResponse } from "../../../support/http.ts";
import { logBinary } from "../../../support/index.ts";
import { getLogger } from "../../../support/logging.ts";

const LOGGER = getLogger("pyatv.protocols.airplay.auth.hap");

const AIRPLAY_HEADERS: Record<string, HeaderValue> = {
  "User-Agent": "AirPlay/320.20",
  Connection: "keep-alive",
  "X-Apple-HKP": 3,
  "Content-Type": "application/octet-stream",
};

const byte = (value: number) => Buffer.from([value]);

/** Options for the AirPlay HAP procedures. */
export interface AirPlayHapOptions {
  /**
   * Extra headers to send with every pairing request. They are merged over the
   * defaults, so a header given here replaces the default one (e.g. "X-Apple-HKP").
   */
  headers?: Record<string, HeaderValue>;
}

/** Options for AirPlay HAP Pair-Setup. */
export interface AirPlayHapPairSetupOptions extends AirPlayHapOptions {
  /** Extra TLV items added to the encrypted sub-TLV sent in M5. */
  additionalData?: Map<number, Buffer>;
}

function mergeHeaders(overrides: Record<string, HeaderValue> | undefined): Record<string, HeaderValue> {
  return { ...AIRPLAY_HEADERS, ...overrides };
}

export function getPairingData(resp: HttpResponse): TlvData {
  if (!Buffer.isBuffer(resp.body)) throw new InvalidResponseError(`got unexpected response: ${resp.body}`);
  return checkTlvError(readTlv(resp.body));
}

/** Authenticate a device for AirPlay playback. */
export class AirPlayHapPairSetupProcedure implements PairSetupProcedure {
  private _atvSalt: Buffer | null = null;
  private _atvPubKey: Buffer | null = null;
  private readonly _headers: Record<string, HeaderValue>;

  constructor(
    readonly http: HttpConnection,
    readonly srp: SRPAuthHandler,
    readonly options: AirPlayHapPairSetupOptions = {},
  ) {
    this._headers = mergeHeaders(options.headers);
  }

  /** Start the authentication process. This method will show the expected PIN on screen. */
  async startPairing(): Promise<void> {
    this.srp.initialize();
    await this.http.post("/pair-pin-start", { headers: this._headers });

    const data = new Map([
      [TlvValue.Method, byte(0x00)],
      [TlvValue.SeqNo, byte(0x01)],
    ]);
    const resp = await this.http.post("/pair-setup", { body: writeTlv(data), headers: this._headers });
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
      headers: this._headers,
    });

    const resp = await this.http.post("/pair-setup", {
      body: writeTlv(
        new Map([
          [TlvValue.SeqNo, byte(0x05)],
          [TlvValue.EncryptedData, this.srp.step3(displayName, this.options.additionalData ?? null)],
        ]),
      ),
      headers: this._headers,
    });
    const pairingData = getPairingData(resp);
    return this.srp.step4(requireTlv(pairingData, TlvValue.EncryptedData));
  }
}

/** Verify if a device is allowed to perform AirPlay playback. */
export class AirPlayHapPairVerifyProcedure implements PairVerifyProcedure {
  private readonly _headers: Record<string, HeaderValue>;

  constructor(
    readonly http: HttpConnection,
    readonly srp: SRPAuthHandler,
    readonly credentials: HapCredentials,
    options: AirPlayHapOptions = {},
  ) {
    this._headers = mergeHeaders(options.headers);
  }

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
    const finalResp = await this._send(
      new Map([
        [TlvValue.SeqNo, byte(0x03)],
        [TlvValue.EncryptedData, encryptedData],
      ]),
    );

    // M4 is empty or only carries the state. If the device rejects our signature (for
    // instance because it no longer knows our identifier) it answers with an error TLV.
    if (Buffer.isBuffer(finalResp.body) && finalResp.body.length > 0) getPairingData(finalResp);
    return true;
  }

  private _send(data: Map<number, Buffer>): Promise<HttpResponse> {
    return this.http.post("/pair-verify", { body: writeTlv(data), headers: this._headers });
  }

  /** Return derived encryption keys. */
  encryptionKeys(salt: string, outputInfo: string, inputInfo: string): [Buffer, Buffer] {
    return this.srp.verify2(salt, outputInfo, inputInfo);
  }

  /** Return the X25519 shared secret of the last verification (the input to all derived keys). */
  sharedSecret(): Buffer {
    return this.srp.verifySharedSecret;
  }
}
