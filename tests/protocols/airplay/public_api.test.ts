/** Tests for the public `tsatv/airplay` entry point and the hooks it exposes. */

import { expect, spyOn, test } from "bun:test";
import * as airplay from "../../../src/airplay.ts";
import {
  AirPlayHapPairSetupProcedure,
  AirPlayHapPairVerifyProcedure,
  AirPlayHapTransientPairVerifyProcedure,
  CONTROL_INPUT_INFO,
  CONTROL_OUTPUT_INFO,
  CONTROL_SALT,
  DATASTREAM_OUTPUT_INFO,
  DATASTREAM_SALT,
  EVENTS_READ_INFO,
  EVENTS_SALT,
  EVENTS_WRITE_INFO,
  hkdfExpand,
  HttpResponse,
  parseCredentials,
  pairSetup,
  pairVerify,
  RtspSession,
  SRPAuthHandler,
  TRANSIENT_CREDENTIALS,
  tlv8,
  verifyConnection,
} from "../../../src/airplay.ts";
import { CLIENT_CREDENTIALS } from "../../../src/auth/server_auth.ts";
import { Protocol } from "../../../src/const.ts";
import { AuthenticationError } from "../../../src/exceptions.ts";
import type { HttpConnection } from "../../../src/support/http.ts";
import { DEVICE_PIN, type FakeAirPlayService } from "../../fake_device/airplay.ts";
import { useAirPlayDevice } from "./shared.ts";

const fixture = useAirPlayDevice();

const serverAuth = (): FakeAirPlayService =>
  fixture.device.services.get(Protocol.AirPlay)!.service as unknown as FakeAirPlayService;

// Record headers of every POST, passing requests through to the fake device.
function recordPosts(connection: HttpConnection): Array<Record<string, unknown>> {
  const sent: Array<Record<string, unknown>> = [];
  const original = connection.post.bind(connection);
  spyOn(connection, "post").mockImplementation((path, options = {}) => {
    sent.push({ path, ...(options.headers as Record<string, unknown>) });
    return original(path, options);
  });
  return sent;
}

test("entry point exports the documented building blocks", () => {
  const expected = [
    // Credentials and pairing
    "AuthenticationType",
    "HapCredentials",
    "parseCredentials",
    "SRPAuthHandler",
    "hkdfExpand",
    "pairSetup",
    "pairVerify",
    "verifyConnection",
    "extractCredentials",
    "AirPlayHapPairSetupProcedure",
    "AirPlayHapPairVerifyProcedure",
    "AirPlayHapTransientPairVerifyProcedure",
    // Connections and channels
    "HttpConnection",
    "httpConnect",
    "RtspSession",
    "HAPSession",
    "AbstractHAPChannel",
    "setupChannel",
    "createConnection",
    "createDatagramEndpoint",
    // Crypto, encodings, timing, features, configuration
    "ChaCha20Poly1305",
    "hkdf",
    "X25519PrivateKey",
    "plistlib",
    "opack",
    "tlv8",
    "timing",
    "TimingServer",
    "AirPlayFlags",
    "parseFeatures",
    "hasFlag",
    "FileStorage",
    "MemoryStorage",
    "Protocol",
  ];
  for (const name of expected) expect((airplay as Record<string, unknown>)[name]).toBeDefined();
});

test("feature helpers detect screen mirroring support", () => {
  const { AirPlayFlags, hasFlag, parseFeatures } = airplay;
  // Features of a current Apple TV (bits 0-31, 32-63)
  const flags = parseFeatures("0x4A7FDFD5,0x3C175FDE");
  expect(hasFlag(flags, AirPlayFlags.SupportsAirPlayScreen)).toBe(true);
  expect(hasFlag(flags, AirPlayFlags.SupportsPTP)).toBe(true);
  expect(hasFlag(parseFeatures("0x00000200"), AirPlayFlags.SupportsAirPlayScreen)).toBe(false);
});

test("hap pair-verify exposes the shared secret behind all derived keys", async () => {
  const connection = await fixture.connection();
  const verifier = await verifyConnection(parseCredentials(CLIENT_CREDENTIALS), connection);
  expect(verifier).toBeInstanceOf(AirPlayHapPairVerifyProcedure);

  const secret = verifier.sharedSecret!();
  expect(secret.length).toBe(32);
  expect(secret).toEqual(serverAuth().sharedKey!);

  // encryptionKeys is HKDF-SHA512 over the very same secret
  const [output, input] = verifier.encryptionKeys(CONTROL_SALT, CONTROL_OUTPUT_INFO, CONTROL_INPUT_INFO);
  expect(output).toEqual(serverAuth().inputKey!);
  expect(input).toEqual(serverAuth().outputKey!);
  expect(hkdfExpand(EVENTS_SALT, EVENTS_READ_INFO, secret)).toEqual(
    verifier.encryptionKeys(EVENTS_SALT, EVENTS_READ_INFO, EVENTS_WRITE_INFO)[0],
  );
  expect(hkdfExpand(`${DATASTREAM_SALT}123`, DATASTREAM_OUTPUT_INFO, secret)).toEqual(
    verifier.encryptionKeys(`${DATASTREAM_SALT}123`, DATASTREAM_OUTPUT_INFO, DATASTREAM_OUTPUT_INFO)[0],
  );
});

test("shared secret is unavailable before verification", () => {
  expect(() => new SRPAuthHandler().verifySharedSecret).toThrow();
});

test("transient pair-verify exposes the srp session key", async () => {
  const connection = await fixture.connection();
  const verifier = pairVerify(TRANSIENT_CREDENTIALS, connection);
  expect(verifier).toBeInstanceOf(AirPlayHapTransientPairVerifyProcedure);
  await verifier.verifyCredentials();
  expect(verifier.sharedSecret!()).toEqual(serverAuth().sharedKey!);
});

test("pair-verify headers can be extended and overridden", async () => {
  const connection = await fixture.connection();
  const sent = recordPosts(connection);
  // The fake device only implements X-Apple-HKP 3, so keep that but add headers.
  const verifier = pairVerify(parseCredentials(CLIENT_CREDENTIALS), connection, {
    headers: { "X-Apple-PD": 1, "User-Agent": "AirPlay/935.7.1" },
  });
  await verifier.verifyCredentials();

  expect(sent.length).toBe(2);
  for (const headers of sent) {
    expect(headers.path).toBe("/pair-verify");
    expect(headers["X-Apple-HKP"]).toBe(3);
    expect(headers["X-Apple-PD"]).toBe(1);
    expect(headers["User-Agent"]).toBe("AirPlay/935.7.1");
  }

  // Default headers are unchanged
  const plain = await fixture.connection();
  const plainSent = recordPosts(plain);
  await pairVerify(parseCredentials(CLIENT_CREDENTIALS), plain).verifyCredentials();
  expect(plainSent[0]!["User-Agent"]).toBe("AirPlay/320.20");
  expect(plainSent[0]!["X-Apple-PD"]).toBeUndefined();
});

test("pair-verify fails when the device reports an error in M4", async () => {
  const connection = await fixture.connection();
  const original = connection.post.bind(connection);
  let calls = 0;
  spyOn(connection, "post").mockImplementation(async (path, options = {}) => {
    const response = await original(path, options);
    if (++calls < 2) return response;
    const body = tlv8.writeTlv(
      new Map([
        [tlv8.TlvValue.SeqNo, Buffer.from([0x04])],
        [tlv8.TlvValue.Error, Buffer.from([tlv8.ErrorCode.Authentication])],
      ]),
    );
    return new HttpResponse(response.protocol, response.version, 200, "OK", {}, body);
  });
  await expect(pairVerify(parseCredentials(CLIENT_CREDENTIALS), connection).verifyCredentials()).rejects.toThrow(
    AuthenticationError,
  );
});

test("pair-setup passes extra M5 data and headers", async () => {
  const connection = await fixture.connection();
  const sent = recordPosts(connection);
  const extra = new Map([[0x12, Buffer.from("acl")]]);
  const procedure = pairSetup(airplay.AuthenticationType.HAP, connection, {
    additionalData: extra,
    headers: { "X-Apple-Client-Name": "test" },
  });
  expect(procedure).toBeInstanceOf(AirPlayHapPairSetupProcedure);
  const step3 = spyOn((procedure as AirPlayHapPairSetupProcedure).srp, "step3");

  await procedure.startPairing();
  const credentials = await procedure.finishPairing("", DEVICE_PIN, "name");

  expect(step3).toHaveBeenCalledWith("name", extra);
  expect(credentials.type).toBe(airplay.AuthenticationType.HAP);
  expect(sent.map((h) => h.path)).toEqual(["/pair-pin-start", "/pair-setup", "/pair-setup", "/pair-setup"]);
  for (const headers of sent) {
    expect(headers["X-Apple-Client-Name"]).toBe("test");
    expect(headers["X-Apple-HKP"]).toBe(3);
  }
});

test("rtsp session user agent and timeout are configurable", async () => {
  const calls: Array<[string, string, Record<string, any>]> = [];
  const connection = {
    localIp: "10.0.0.2",
    remoteIp: "10.0.0.1",
    sendAndReceive: async (method: string, uri: string, options: Record<string, any>) => {
      calls.push([method, uri, options]);
      return new HttpResponse("RTSP", "1.0", 200, "OK", { CSeq: options.headers.CSeq }, Buffer.alloc(0));
    },
  } as unknown as HttpConnection;

  const rtsp = new RtspSession(connection);
  await rtsp.exchange("GET", { uri: "/info" });
  expect(calls[0]![2].userAgent).toBe("AirPlay/550.10");
  expect(calls[0]![2].timeout).toBeUndefined();

  rtsp.userAgent = "AirPlay/935.7.1";
  await rtsp.exchange("SETUP", { uri: "rtsp://10.0.0.1/1", body: { streams: [] }, timeout: 30 });
  expect(calls[1]![0]).toBe("SETUP");
  expect(calls[1]![2].userAgent).toBe("AirPlay/935.7.1");
  expect(calls[1]![2].timeout).toBe(30);
  expect(calls[1]![2].headers["Content-Type"]).toBe("application/x-apple-binary-plist");
});
