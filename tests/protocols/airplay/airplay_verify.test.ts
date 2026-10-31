/** Functional credential verification tests using the API with a fake AirPlay Apple TV. */

import { expect, test } from "bun:test";
import { type HapCredentials, parseCredentials, TRANSIENT_CREDENTIALS } from "../../../src/auth/hap_pairing.ts";
import { CLIENT_CREDENTIALS } from "../../../src/auth/server_auth.ts";
import { Protocol } from "../../../src/const.ts";
import { AuthenticationError } from "../../../src/exceptions.ts";
import { pairVerify } from "../../../src/protocols/airplay/auth/index.ts";
import { httpConnect } from "../../../src/support/http.ts";
import { DEVICE_CREDENTIALS } from "../../fake_device/airplay.ts";
import { useAirPlayDevice } from "./shared.ts";

const fixture = useAirPlayDevice();

test.each([
  ["device credentials", parseCredentials(DEVICE_CREDENTIALS), false],
  ["invalid legacy", parseCredentials(`${"00".repeat(8)}:${"11".repeat(32)}`), true],
  ["client credentials", parseCredentials(CLIENT_CREDENTIALS), false],
  ["invalid hap", parseCredentials(`${"00".repeat(32)}:${"11".repeat(32)}:${"22".repeat(36)}:${"33".repeat(36)}`), true],
  ["transient", TRANSIENT_CREDENTIALS, false],
] as Array<[string, HapCredentials, boolean]>)("verify %s", async (_name, credentials, raises) => {
  const conf = fixture.conf();
  const connection = await httpConnect(String(conf.address), conf.getService(Protocol.AirPlay)!.port);
  try {
    const verifier = pairVerify(credentials, connection);
    if (raises) await expect(verifier.verifyCredentials()).rejects.toThrow(AuthenticationError);
    else await verifier.verifyCredentials();
  } finally {
    connection.close();
  }
});
