/** Methods used to GET/POST data from/to an Apple TV. */

import { DeviceState, MediaType } from "../../const.ts";
import {
  AuthenticationError,
  InvalidCredentialsError,
  NotSupportedError,
  UnknownMediaKindError,
  UnknownPlayStateError,
} from "../../exceptions.ts";
import type { HttpSession } from "../../support/http.ts";
import { logBinary } from "../../support/index.ts";
import { getLogger, LogLevel } from "../../support/logging.ts";
import * as parser from "./parser.ts";
import { lookupTag } from "./tag_definitions.ts";

const LOGGER = getLogger("pyatv.protocols.dmap.daap");

export const DMAP_HEADERS: Record<string, string> = {
  Accept: "*/*",
  "Accept-Encoding": "gzip",
  "Client-DAAP-Version": "3.13",
  "Client-ATV-Sharing-Version": "1.2",
  "Client-iTunes-Sharing-Version": "3.15",
  "User-Agent": "Remote/1021",
  "Viewer-Only-Client": "1",
};

export const DEFAULT_TIMEOUT = 10.0; // Seconds

/** Convert iTunes media kind to API representation. */
export function mediaKind(kind: number): MediaType {
  if ([1, 32770].includes(kind)) return MediaType.Unknown;
  if ([3, 7, 11, 12, 13, 18, 32].includes(kind)) return MediaType.Video;
  if ([2, 4, 10, 14, 17, 21, 36].includes(kind)) return MediaType.Music;
  if ([8, 64].includes(kind)) return MediaType.TV;
  throw new UnknownMediaKindError("Unknown media kind: " + String(kind));
}

/** Convert iTunes playstate to API representation. */
export function playstate(state: number | null | undefined): DeviceState {
  if (state === 0 || state === null || state === undefined) return DeviceState.Idle;
  if (state === 1) return DeviceState.Loading;
  if (state === 2) return DeviceState.Stopped;
  if (state === 3) return DeviceState.Paused;
  if (state === 4) return DeviceState.Playing;
  if (state === 5 || state === 6) return DeviceState.Seeking;
  throw new UnknownPlayStateError("Unknown playstate: " + String(state));
}

/** Convert time in ms to seconds. */
export function msToS(time: number | null | undefined): number {
  if (time === null || time === undefined) return 0;
  // Happens in some special cases, just return 0
  if (time >= 2 ** 32 - 1) return 0;
  // Python's round() uses banker's rounding
  const value = time / 1000.0;
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff === 0.5) return floor % 2 === 0 ? floor : floor + 1;
  return Math.round(value);
}

type Action = { run: () => Promise<[Buffer, number]>; logText: string };

/**
 * Helper class that makes it easy to perform DAAP requests.
 *
 * It will automatically do login and other necessary book-keeping.
 */
export class DaapRequester {
  private _sessionId = 0;

  constructor(
    readonly http: HttpSession,
    private readonly _loginId: string | null,
  ) {}

  /** Login to Apple TV using specified login id. */
  async login(): Promise<number> {
    // Do not use get(...) in login as that would end up in an infinite loop.
    const url = this._mkurl("login?[AUTH]&hasFP=1", false, true);
    const action: Action = {
      logText: "Login request: " + url,
      run: () => this.http.getData(url, DMAP_HEADERS),
    };

    const resp = await this._do(action, true, true);
    this._sessionId = parser.first(resp, "mlog", "mlid");

    LOGGER.info("Logged in and got session id %s", this._sessionId);
    return this._sessionId;
  }

  /** Perform a DAAP GET command. */
  async get(
    cmd: string,
    options: { daapData?: boolean; timeout?: number | null; signal?: AbortSignal } = {},
  ): Promise<any> {
    await this._assureLoggedIn();
    const url = this._mkurl(cmd);
    const action: Action = {
      logText: "GET request: " + url,
      run: () => this.http.getData(url, DMAP_HEADERS, options.timeout ?? undefined, options.signal),
    };
    return this._do(action, true, false, options.daapData ?? true);
  }

  /** Perform DAAP POST command with optional data. */
  async post(cmd: string, data: Uint8Array | null = null, timeout: number | null = null): Promise<any> {
    await this._assureLoggedIn();
    const url = this._mkurl(cmd);
    const headers = { ...DMAP_HEADERS, "Content-Type": "application/x-www-form-urlencoded" };
    const action: Action = {
      logText: "POST request: " + url,
      run: () => this.http.postData(url, data, headers, timeout ?? undefined),
    };
    return this._do(action);
  }

  private async _do(action: Action, retry = true, isLogin = false, isDaap = true): Promise<any> {
    const [respData, status] = await action.run();
    const resp = isDaap ? parser.parse(respData, lookupTag) : respData;

    this._logResponse(action.logText, resp, isDaap);
    if (status >= 200 && status < 300) return resp;

    // Seems to be the case?
    if (status === 500) throw new NotSupportedError("command not supported at this stage");

    if (!isLogin) {
      // If a request fails, try to login again before retrying
      LOGGER.info("implicitly logged out, logging in again");
      await this.login();
    }

    // Retry once if we got a bad response, otherwise bail out
    if (retry) return this._do(action, false, isLogin, isDaap);

    throw new AuthenticationError(`failed to login: ${status}`);
  }

  private _mkurl(cmd: string, session = true, loginId = false): string {
    const parameters: string[] = [];
    if (loginId) {
      const id = this._loginId ?? "";
      if (/^0x[0-9A-Fa-f]{16}/.test(id)) {
        parameters.push(`pairing-guid=${id}`);
      } else if (/^[0-9A-Fa-f]{8}-([0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}/.test(id)) {
        parameters.push(`hsgid=${id}`);
      } else {
        throw new InvalidCredentialsError(`invalid credentials: ${this._loginId}`);
      }
    }
    if (session) parameters.unshift(`session-id=${this._sessionId}`);
    return cmd.replace("[AUTH]", parameters.join("&"));
  }

  private async _assureLoggedIn(): Promise<void> {
    if (this._sessionId !== 0) {
      LOGGER.debug("Already logged in, reusing session id %d", this._sessionId);
    } else {
      await this.login();
    }
  }

  private _logResponse(text: string, data: unknown, isDaap: boolean): void {
    if (LOGGER.isEnabledFor(LogLevel.INFO)) {
      if (isDaap) LOGGER.debug("%s", parser.pprint(data, lookupTag));
      else logBinary(LOGGER, text, { Data: data });
    }
  }
}
