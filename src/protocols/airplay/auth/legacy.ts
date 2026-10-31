/** Implementation of legacy pairing for AirPlay. */

import type { HapCredentials, PairSetupProcedure, PairVerifyProcedure } from "../../../auth/hap_pairing.ts";
import { NotSupportedError, ProtocolError } from "../../../exceptions.ts";
import { decodeBplistFromBody, type HttpConnection, type HttpResponse } from "../../../support/http.ts";
import * as plistlib from "../../../support/plistlib.ts";
import type { LegacySRPAuthHandler } from "../srp.ts";

const AIRPLAY_HEADERS = {
  "User-Agent": "AirPlay/320.20",
  Connection: "keep-alive",
};

/** Authenticate a device for AirPlay playback. */
export class AirPlayLegacyPairSetupProcedure implements PairSetupProcedure {
  constructor(
    readonly http: HttpConnection,
    readonly srp: LegacySRPAuthHandler,
  ) {}

  /** Start the pairing process. This method will show the expected PIN on screen. */
  async startPairing(): Promise<void> {
    await this.http.post("/pair-pin-start", { headers: AIRPLAY_HEADERS });
  }

  /** Finish pairing process. */
  async finishPairing(_username: string, pinCode: number | string, _displayName: string | null): Promise<HapCredentials> {
    // Step 1
    const clientId = this.srp.credentials.clientId.toString("hex").toUpperCase();
    this.srp.step1(clientId, pinCode);
    const resp = await this._sendPlist({ method: "pin", user: clientId });
    const body = decodeBplistFromBody(resp);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new ProtocolError(`expected dict, got ${typeof body}`);
    }

    // Step 2
    const [pubKey, keyProof] = this.srp.step2(body.pk, body.salt);
    await this._sendPlist({ pk: pubKey, proof: keyProof });

    // Step 3
    const [epk, tag] = this.srp.step3();
    await this._sendPlist({ epk, authTag: tag });
    return this.srp.credentials;
  }

  private _sendPlist(plist: Record<string, unknown>): Promise<HttpResponse> {
    return this.http.post("/pair-setup-pin", {
      headers: { ...AIRPLAY_HEADERS, "Content-Type": "application/x-apple-binary-plist" },
      body: plistlib.dumps(plist, plistlib.FMT_BINARY),
    });
  }
}

/** Verify if a device is allowed to perform AirPlay playback. */
export class AirPlayLegacyPairVerifyProcedure implements PairVerifyProcedure {
  constructor(
    readonly http: HttpConnection,
    readonly srp: LegacySRPAuthHandler,
  ) {}

  async verifyCredentials(): Promise<boolean> {
    const resp = await this._send(this.srp.verify1());
    const body = resp.body as Buffer;
    const atvPublicSecret = body.subarray(0, 32);
    const data = body.subarray(32); // TODO: what is this?
    await this._send(this.srp.verify2(atvPublicSecret, data));
    return false;
  }

  private _send(data: Buffer): Promise<HttpResponse> {
    return this.http.post("/pair-verify", {
      headers: { ...AIRPLAY_HEADERS, "Content-Type": "application/octet-stream" },
      body: data,
    });
  }

  encryptionKeys(_salt: string, _outputInfo: string, _inputInfo: string): [Buffer, Buffer] {
    throw new NotSupportedError("encryption keys not supported by legacy auth");
  }
}
