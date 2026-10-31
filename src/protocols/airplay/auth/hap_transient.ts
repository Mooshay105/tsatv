/**
 * Support for HAP transient pairing.
 *
 * Technically, transient pairing only covers the first four states of regular pairing
 * (M1-M4). The shared secret is then used to derive keys. The way pyatv is structured
 * makes it easier to implement as the verification procedure step instead.
 */

import type { PairVerifyProcedure } from "../../../auth/hap_pairing.ts";
import { hkdfExpand, type SRPAuthHandler } from "../../../auth/hap_srp.ts";
import { Flags, TlvValue, writeTlv } from "../../../auth/hap_tlv8.ts";
import type { HttpConnection } from "../../../support/http.ts";
import { logBinary } from "../../../support/index.ts";
import { getLogger } from "../../../support/logging.ts";
import { getPairingData } from "./hap.ts";

const LOGGER = getLogger("pyatv.protocols.airplay.auth.hap_transient");

const AIRPLAY_HEADERS = {
  "User-Agent": "AirPlay/320.20",
  Connection: "keep-alive",
  "X-Apple-HKP": 4,
  "Content-Type": "application/octet-stream",
};

export const TRANSIENT_PIN = 3939;

const byte = (value: number) => Buffer.from([value]);

/** Verify if a device is allowed to perform AirPlay playback (transient pairing). */
export class AirPlayHapTransientPairVerifyProcedure implements PairVerifyProcedure {
  constructor(
    readonly http: HttpConnection,
    readonly srp: SRPAuthHandler,
  ) {}

  async verifyCredentials(): Promise<boolean> {
    this.srp.initialize();

    await this.http.post("/pair-pin-start", { headers: AIRPLAY_HEADERS });

    const resp = await this.http.post("/pair-setup", {
      body: writeTlv(
        new Map([
          [TlvValue.Method, byte(0x00)],
          [TlvValue.SeqNo, byte(0x01)],
          [TlvValue.Flags, byte(Flags.TransientPairing)],
        ]),
      ),
      headers: AIRPLAY_HEADERS,
    });

    const pairingData = getPairingData(resp);
    const atvSalt = pairingData.get(TlvValue.Salt)!;
    const atvPubKey = pairingData.get(TlvValue.PublicKey)!;

    this.srp.step1(TRANSIENT_PIN);

    const [pubKey, proof] = this.srp.step2(atvPubKey, atvSalt);
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

    return true;
  }

  encryptionKeys(salt: string, outputInfo: string, inputInfo: string): [Buffer, Buffer] {
    const shared = this.srp.sharedKey;
    const outputKey = hkdfExpand(salt, outputInfo, shared);
    const inputKey = hkdfExpand(salt, inputInfo, shared);
    logBinary(LOGGER, "Keys", { Output: outputKey, Input: inputKey });
    return [outputKey, inputKey];
  }
}
