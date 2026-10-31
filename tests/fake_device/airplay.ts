/** A fake AirPlay device. */

import { Protocol } from "../../src/const.ts";
import { AirPlayServerAuth } from "../../src/protocols/airplay/server_auth.ts";
import type { Server } from "../../src/support/transport.ts";
import { BasicHttpServer, HttpRequest, HttpResponse, httpServer } from "../../src/support/http.ts";
import { getLogger } from "../../src/support/logging.ts";
import * as plistlib from "../../src/support/plistlib.ts";
import { getDigestPayload } from "../../src/support/rtsp.ts";
import { simpleGet } from "../utils.ts";
import { registerFake } from "./index.ts";
import type { WebApp } from "./web.ts";

const LOGGER = getLogger("tests.fake_device.airplay");

// --- START AUTHENTICATION DATA VALID SESSION (FROM DEVICE) ---

export const DEVICE_NAME = "Fake AirPlay ATV";
export const DEVICE_IDENTIFIER = "75FBEEC773CFC563";
export const DEVICE_AUTH_KEY = "8F06696F2542D70DF59286C761695C485F815BE3D152849E1361282D46AB1493";
export const DEVICE_PIN = 2271;
export const DEVICE_CREDENTIALS = DEVICE_IDENTIFIER + ":" + DEVICE_AUTH_KEY;

// For authentication
const DEVICE_AUTH_STEP1 = "62706c6973743030d201020304566d6574686f6454757365725370696e5f101037354642454543373733434643353633080d14191d0000000000000101000000000000000500000000000000000000000000000030";
const DEVICE_AUTH_STEP1_RESP = "62706c6973743030d20102030452706b5473616c744f1101008817e16146c7d12b45e810b0bf190a4ccb25d9a20a8d0504d874daa8db5574c51c8b33703a95c00bdbe99c8c3745d1ef1b38e538edfd98e09ec029effe6f28b3b54a1bd41c28d8f33da6f5ac9327bfce9a66869dae645b5cbd2c6b8fbe14a30ad4f8598154f2ef7f4f52cee3e3042a69780463c26bbb764870eb1995b26a2a4ade05564836d788baf07469a143c410ea9d07a068eb790b2b0aa5b86c990636814e3fa1a899ceba1af45b211ca4bd3b5b66ffaf16051a4f851e120476054258f257b8521a068907ad5e9c7220d5cef9aa072dec9edb7ebf633cad4d52d105cf58440f17e236332b0b26539851a879e9ac8d3c2da4c590785468e590296d39d7374f1010fca6dcb6b83a7c716a692f806e9159540008000d001000150119000000000000020100000000000000050000000000000000000000000000012c";
const DEVICE_AUTH_STEP2 = "62706c6973743030d20102030452706b5570726f6f664f1101000819b6ba7feead4753809314e2b4c5db9109f737a0fc70b758342b6bbf536fae4e40cf94607588abb17c2076030cc00c2c1fa5fc3b3dfe8aa1ec2f23f74d917c0792fbf02f131377dfb8ae2a1656ceaa0a36bb3ab752586e1af17e1d5ef24ce083f3f9298d0be761f26c0d48af86510bf9aac7940cf90bff6bd214cf34b5536856c80f076cfbe06fd69af9d6a07a6d3ac580dfffc8a40b9730575a16c5046cd73321a944880dcf9fac952afc7ffd2d135e57ec208b11cef22b734f331ad4d8c9a737b588f7b30bd5210c65cae2ba0226f69ce7b505771faa63af89ed2f9e8325d7d5f3a2da7412f9d837860632d7f81b7fa5e09dd85e1539184070c0fa8433c24f1014fc6286910833d3e7ae0631d47ddbb0f492ef85b80008000d00100016011a0000000000000201000000000000000500000000000000000000000000000131";
const DEVICE_AUTH_STEP2_RESP = "62706c6973743030d101025570726f6f664f101484a88548b12bce122ad1cea6caff312630edcf27080b110000000000000101000000000000000300000000000000000000000000000028";
const DEVICE_AUTH_STEP3 = "62706c6973743030d20102030457617574685461675365706b4f101052a92f8712c6ea417f3adb3d03d8e5634f1020ff07fc8520d10728e6f2ab0a0245dfa20709b5d1ae5f9a19328b0663ba9414f2080d15192c000000000000010100000000000000050000000000000000000000000000004f";
const DEVICE_AUTH_STEP3_RESP = "62706c6973743030d2010203045365706b57617574685461674f10206285b20afad4cefe1fce40cee685ab072c75240cb47fb71bc3b3d03dca52dc5d4f1010893eb8e5ae418b245e9b1bf7cba9116b080d11193c000000000000010100000000000000050000000000000000000000000000004f";

// For verification
const DEVICE_VERIFY_STEP1 = "01000000891bae9f581f68f9c9933c4f713fbb5b9de639ec7df5d0a4fd4f342f1c21aa6a5e9d1e843302d6265b8c48dd169e273460e567916b0b36280ac071001118f6b2";
const DEVICE_VERIFY_STEP1_RESP = "3221371da9f00d035955caa912455fd2acee68117b557f25e39168746af4b631cfab7b2c6d0b58e96cc10af884f5a4cdef8063858a9d9c04e866743cf4b77b4be50de1352ab4ff2691a1a7afd8c1341475b4170ac50455973b7fcf3c24324fa9";
const DEVICE_VERIFY_STEP2 = "00000000a1f91acf64aacb185684080b817103b423816ad63b7f5e001f62337b4cc4b3b92c1474959930b7c2a59d0004814300580459d06fc6cc6441bd82bac72a5c5cc7";
const DEVICE_VERIFY_STEP2_RESP = ""; // Value not used by pyatv

// --- END AUTHENTICATION DATA ---

export interface AirPlayPlaybackResponse {
  code: number;
  content: Buffer | null;
}

export class FakeAirPlayState {
  airplayResponses: AirPlayPlaybackResponse[] = [];
  hasAuthenticated = true;
  alwaysAuthFail = false;
  lastAirplayUrl: string | null = null;
  lastAirplayStart: number | null = null;
  lastAirplayUuid: string | null = null;
  lastAirplayContent: Buffer | null = null;
  playCount = 0;
  injectedPlayFails = 0;
  /** Password required by receiver (digest authentication), null if none. */
  password: string | null = null;
}

const DIGEST_REALM = "airplay";
const DIGEST_NONCE = "4a6f1bb7c3c1b4b8";

const bodyOf = (request: HttpRequest): Buffer =>
  Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body, "utf-8");

const response = (request: HttpRequest, code: number, message: string, body: Buffer = Buffer.alloc(0), headers = {}) =>
  new HttpResponse(request.protocol, request.version, code, message, headers, body);

export class FakeAirPlayService extends AirPlayServerAuth {
  server: Server | null = null;
  port = 0;

  constructor(
    readonly state: FakeAirPlayState,
    readonly app: WebApp,
  ) {
    super(DEVICE_NAME, undefined, DEVICE_PIN);
    this.addRoute("POST", "^/play$", (r) => this.handleAirplayPlay(r));
    this.addRoute("GET", "^/playback-info$", (r) => this.handleAirplayPlaybackInfo(r));
    this.addRoute("POST", "^/pair-setup-pin$", (r) => this.handlePairSetupPin(r));
  }

  async start(_startWebServer: boolean): Promise<void> {
    [this.server, this.port] = await httpServer(() => new BasicHttpServer(this), "0.0.0.0");
    LOGGER.debug("start %s", this.port);
  }

  async cleanup(): Promise<void> {
    this.server?.close();
  }

  /** Handle AirPlay play requests. */
  // Return a 401 response if password is required and request is not authenticated
  private checkPassword(request: HttpRequest): HttpResponse | null {
    if (this.state.password === null) return null;
    const expected = getDigestPayload(
      request.method,
      request.path,
      "AirPlay",
      DIGEST_REALM,
      this.state.password,
      DIGEST_NONCE,
    );
    if (request.headers.get("Authorization") === expected) return null;
    return response(request, 401, "Unauthorized", Buffer.alloc(0), {
      "WWW-Authenticate": `Digest realm="${DIGEST_REALM}", nonce="${DIGEST_NONCE}"`,
    });
  }

  handleAirplayPlay(request: HttpRequest): HttpResponse | Promise<HttpResponse> {
    const unauthorized = this.checkPassword(request);
    if (unauthorized) return unauthorized;
    this.state.playCount += 1;

    if (this.state.alwaysAuthFail || !this.state.hasAuthenticated) {
      return response(request, 503, "Service Unavailable");
    }
    if (this.state.injectedPlayFails > 0) {
      this.state.injectedPlayFails -= 1;
      return response(request, 500, "Internal Server Error");
    }

    const headers = request.headers;
    if (headers.get("User-Agent") !== "MediaControl/1.0") throw new Error("bad User-Agent");
    if (headers.get("Content-Type") !== "application/x-apple-binary-plist") throw new Error("bad Content-Type");

    const parsed = plistlib.loads(bodyOf(request)) as Record<string, any>;
    this.state.lastAirplayUrl = parsed["Content-Location"];
    this.state.lastAirplayStart = Number(parsed["Start-Position"]);
    this.state.lastAirplayUuid = parsed["X-Apple-Session-ID"];

    // Simulate that fake device streams if URL is localhost
    if (this.state.lastAirplayUrl!.startsWith("http://127.0.0.1")) {
      LOGGER.debug("Retrieving file from %s", this.state.lastAirplayUrl);
      return (async () => {
        [this.state.lastAirplayContent] = await simpleGet(this.state.lastAirplayUrl!);
        return response(request, 200, "OK");
      })();
    }
    return response(request, 200, "OK");
  }

  /** Handle AirPlay playback-info requests. */
  handleAirplayPlaybackInfo(request: HttpRequest): HttpResponse {
    const unauthorized = this.checkPassword(request);
    if (unauthorized) return unauthorized;
    const resp = this.state.airplayResponses.pop() ?? {
      code: 200,
      content: plistlib.dumps({ readyToPlay: false, uuid: 123 }),
    };
    return response(request, resp.code, "...", resp.content ?? Buffer.alloc(0), {
      "Content-Type": "text/x-apple-plist+xml",
    });
  }

  /** Handle AirPlay device authentication requests. */
  handlePairSetupPin(request: HttpRequest): HttpResponse {
    const hexlified = bodyOf(request).toString("hex");
    LOGGER.debug("handle_pair_setup_pin %s", hexlified);
    const steps: Record<string, string> = {
      [DEVICE_AUTH_STEP1]: DEVICE_AUTH_STEP1_RESP,
      [DEVICE_AUTH_STEP2]: DEVICE_AUTH_STEP2_RESP,
      [DEVICE_AUTH_STEP3]: DEVICE_AUTH_STEP3_RESP,
    };
    const resp = steps[hexlified];
    if (resp !== undefined) return response(request, 200, "OK", Buffer.from(resp, "hex"));
    return response(request, 403, "Not Authenticated");
  }

  override handlePairVerify(request: HttpRequest): HttpResponse {
    const resp = super.handlePairVerify(request);
    if (resp.code === 501) return this.handleLegacyPairVerify(request);
    return resp;
  }

  /** Handle verification of AirPlay device authentication. */
  handleLegacyPairVerify(request: HttpRequest): HttpResponse {
    const hexlified = bodyOf(request).toString("hex");
    if (hexlified === DEVICE_VERIFY_STEP1) {
      return response(request, 200, "OK", Buffer.from(DEVICE_VERIFY_STEP1_RESP, "hex"));
    }
    if (hexlified === DEVICE_VERIFY_STEP2) {
      this.state.hasAuthenticated = true;
      return response(request, 200, "OK", Buffer.from(DEVICE_VERIFY_STEP2_RESP, "hex"));
    }
    return response(request, 403, "Forbidden");
  }

  enableEncryption(_outputKey: Uint8Array, _inputKey: Uint8Array): void {}
}

/** Wrapper for altering behavior of a FakeAirPlayDevice instance. */
export class FakeAirPlayUseCases {
  constructor(readonly state: FakeAirPlayState) {}

  /** Make play command fail a number of times. */
  airplayPlayFailure(count: number): void {
    this.state.injectedPlayFails = count;
  }

  /** Make playback-info return idle info. */
  airplayPlaybackIdle(): void {
    this.state.airplayResponses.unshift({ code: 200, content: plistlib.dumps({ readyToPlay: false, uuid: 123 }) });
  }

  /** Make playback-info return that something is playing. */
  airplayPlaybackPlaying(): void {
    // This is _not_ complete, currently not needed
    this.state.airplayResponses.unshift({ code: 200, content: plistlib.dumps({ duration: 0.8 }) });
  }

  /** Require device authentication for AirPlay. */
  airplayRequireAuthentication(): void {
    this.state.hasAuthenticated = false;
  }

  /** Always fail authentication for AirPlay. */
  airplayAlwaysFailAuthentication(): void {
    this.state.alwaysAuthFail = true;
  }

  /** Make playback-info return forbidden. */
  airplayPlaybackPlayingNoPermission(): void {
    this.state.airplayResponses.unshift({ code: 403, content: null });
  }
}

registerFake(
  Protocol.AirPlay,
  (state, app) => new FakeAirPlayService(state, app),
  () => new FakeAirPlayState(),
  (state) => new FakeAirPlayUseCases(state),
);
