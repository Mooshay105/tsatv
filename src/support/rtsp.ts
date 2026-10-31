/**
 * Implementation of the RTSP protocol.
 *
 * This is a simple implementation of the RTSP protocol used by Apple (with its quirks
 * and all). It is somewhat generalized to support both AirPlay 1 and 2.
 */

import { randomBytes, randomInt } from "node:crypto";
import type { MediaMetadata } from "../interface.ts";
import * as tags from "../protocols/dmap/tags.ts";
import { Event, TimeoutError, waitFor } from "./asyncio.ts";
import { decodeBplistFromBody, getDigestPayload, type HeadersInit, type HttpConnection, type HttpResponse } from "./http.ts";
import { getLogger } from "./logging.ts";
import * as plistlib from "./plistlib.ts";

const LOGGER = getLogger("pyatv.support.rtsp");

export const FRAMES_PER_PACKET = 352;
export const USER_AGENT = "AirPlay/550.10";
export const HTTP_PROTOCOL = "HTTP/1.1";

const announcePayload = (o: {
  sessionId: number;
  localIp: string;
  remoteIp: string;
  bitsPerChannel: number;
  channels: number;
  sampleRate: number;
}) =>
  "v=0\r\n" +
  `o=iTunes ${o.sessionId} 0 IN IP4 ${o.localIp}\r\n` +
  "s=iTunes\r\n" +
  `c=IN IP4 ${o.remoteIp}\r\n` +
  "t=0 0\r\n" +
  "m=audio 0 RTP/AVP 96\r\n" +
  "a=rtpmap:96 L16/44100/2\r\n" +
  `a=fmtp:96 ${FRAMES_PER_PACKET} 0 ` +
  `${o.bitsPerChannel} 40 10 14 ${o.channels} 255 0 0 ${o.sampleRate}\r\n`;

// Used to signal that traffic is to be unencrypted
export const AUTH_SETUP_UNENCRYPTED = Buffer.from([0x01]);

// Just a static Curve25519 public key used to satisfy the auth-setup step for devices
// requiring that (e.g. AirPort Express). We never verify anything.
export const CURVE25519_PUB_KEY = Buffer.from("5902ede90d4ef2bd4cb68a6330038207a94dbd50d8aa465b5d8c012a0c7e1d4e", "hex");

export const BPLIST_CONTENT_TYPE = "application/x-apple-binary-plist";

/** OAuth information used for password protected devices. */
export interface DigestInfo {
  username: string;
  realm: string;
  password: string;
  nonce: string;
}

export { getDigestPayload, parseDigestChallenge } from "./http.ts";

/** Representation of an RTSP session. */
export class RtspSession {
  readonly requests = new Map<number, [Event, HttpResponse | null]>();
  digestInfo: DigestInfo | null = null;
  cseq = 0;
  sessionId: number = randomInt(0, 2 ** 32 - 1);
  dacpId: string = randomBytes(8).readBigUInt64BE().toString(16).toUpperCase();
  activeRemote: number = randomInt(0, 2 ** 32 - 1);

  constructor(readonly connection: HttpConnection) {}

  /** Return URI used for session requests. */
  get uri(): string {
    return `rtsp://${this.connection.localIp}/${this.sessionId}`;
  }

  /** Return device information. */
  async info(): Promise<Record<string, unknown>> {
    const deviceInfo = await this.exchange("GET", { uri: "/info", allowError: true });

    // If not supported, just return an empty dict
    if (deviceInfo.code !== 200) {
      LOGGER.debug("Device does not support /info");
      return {};
    }
    return decodeBplistFromBody(deviceInfo);
  }

  /** Send auth-setup message. */
  authSetup(): Promise<HttpResponse> {
    // Payload to say that we want to proceed unencrypted
    const body = Buffer.concat([AUTH_SETUP_UNENCRYPTED, CURVE25519_PUB_KEY]);
    return this.exchange("POST", {
      uri: "/auth-setup",
      contentType: "application/octet-stream",
      body,
      protocol: HTTP_PROTOCOL,
    });
  }

  /** Send ANNOUNCE message. */
  async announce(
    bytesPerChannel: number,
    channels: number,
    sampleRate: number,
    password: string | null,
  ): Promise<HttpResponse> {
    const body = announcePayload({
      sessionId: this.sessionId,
      localIp: this.connection.localIp,
      remoteIp: this.connection.remoteIp,
      bitsPerChannel: 8 * bytesPerChannel,
      channels,
      sampleRate,
    });

    const requiresPassword = password !== null && password !== undefined;

    let response = await this.exchange("ANNOUNCE", {
      contentType: "application/sdp",
      body,
      allowError: requiresPassword,
    });

    // Save the necessary data for password authentication
    const wwwAuthenticate = response.headers.get("www-authenticate");
    if (response.code === 401 && wwwAuthenticate && requiresPassword) {
      const parts = wwwAuthenticate.split('"');
      this.digestInfo = { username: "pyatv", realm: parts[1]!, password: password!, nonce: parts[3]! };
      response = await this.exchange("ANNOUNCE", { contentType: "application/sdp", body });
    }
    return response;
  }

  /** Send SETUP message. */
  setup(options: { headers?: HeadersInit; body?: string | Uint8Array | Record<string, unknown> | null } = {}): Promise<HttpResponse> {
    return this.exchange("SETUP", options);
  }

  /** Send RECORD message. */
  record(options: { headers?: HeadersInit; body?: string | Uint8Array | null } = {}): Promise<HttpResponse> {
    return this.exchange("RECORD", options);
  }

  /** Send FLUSH message. */
  flush(options: { headers?: HeadersInit; body?: string | Uint8Array | null } = {}): Promise<HttpResponse> {
    return this.exchange("FLUSH", options);
  }

  /** Send SET_PARAMETER message. */
  setParameter(parameter: string, value: string): Promise<HttpResponse> {
    return this.exchange("SET_PARAMETER", { contentType: "text/parameters", body: `${parameter}: ${value}` });
  }

  /** Change metadata for what is playing. */
  setMetadata(rtspSession: number, rtpseq: number, rtptime: number, metadata: MediaMetadata): Promise<HttpResponse> {
    const parts: Buffer[] = [];
    if (metadata.title) parts.push(tags.stringTag("minm", metadata.title));
    if (metadata.album) parts.push(tags.stringTag("asal", metadata.album));
    if (metadata.artist) parts.push(tags.stringTag("asar", metadata.artist));

    return this.exchange("SET_PARAMETER", {
      contentType: "application/x-dmap-tagged",
      headers: { Session: rtspSession, "RTP-Info": `seq=${rtpseq};rtptime=${rtptime}` },
      body: tags.containerTag("mlit", Buffer.concat(parts)),
    });
  }

  /** Change artwork for what is playing. */
  setArtwork(rtspSession: number, rtpseq: number, rtptime: number, artwork: Buffer): Promise<HttpResponse> {
    return this.exchange("SET_PARAMETER", {
      contentType: "image/jpeg",
      headers: { Session: rtspSession, "RTP-Info": `seq=${rtpseq};rtptime=${rtptime}` },
      body: artwork,
    });
  }

  /** Send feedback message. */
  feedback(allowError = false): Promise<HttpResponse> {
    return this.exchange("POST", { uri: "/feedback", allowError });
  }

  /** Send TEARDOWN message. */
  teardown(rtspSession: number): Promise<HttpResponse> {
    return this.exchange("TEARDOWN", { headers: { Session: rtspSession } });
  }

  /** Send a RTSP message and return response. */
  async exchange(
    method: string,
    options: {
      uri?: string | null;
      contentType?: string | null;
      headers?: HeadersInit;
      body?: string | Uint8Array | Record<string, unknown> | null;
      allowError?: boolean;
      protocol?: string;
    } = {},
  ): Promise<HttpResponse> {
    const cseq = this.cseq;
    this.cseq += 1;

    const hdrs: Record<string, string | number> = {
      CSeq: cseq,
      "DACP-ID": this.dacpId,
      "Active-Remote": this.activeRemote,
      "Client-Instance": this.dacpId,
    };

    // Add the password authentication if required
    if (this.digestInfo) {
      const d = this.digestInfo;
      hdrs.Authorization = getDigestPayload(method, options.uri ?? this.uri, d.username, d.realm, d.password, d.nonce);
    }

    if (options.headers) {
      const entries =
        options.headers instanceof Map
          ? [...options.headers.entries()]
          : Symbol.iterator in Object(options.headers)
            ? [...(options.headers as Iterable<[string, string]>)]
            : Object.entries(options.headers);
      for (const [key, value] of entries) hdrs[key] = value as string;
    }

    // If body is a dict, assume that payload should be sent as a binary plist
    let body = options.body ?? null;
    if (body !== null && typeof body === "object" && !(body instanceof Uint8Array)) {
      hdrs["Content-Type"] = BPLIST_CONTENT_TYPE;
      body = plistlib.dumps(body, plistlib.FMT_BINARY);
    }

    // Map an Event to current CSeq and make the request
    this.requests.set(cseq, [new Event(), null]);
    const resp = await this.connection.sendAndReceive(method, options.uri ?? this.uri, {
      protocol: options.protocol ?? "RTSP/1.0",
      userAgent: USER_AGENT,
      contentType: options.contentType ?? null,
      headers: hdrs,
      body: body as string | Uint8Array | null,
      allowError: options.allowError ?? false,
    });

    // The response most likely contains a CSeq and it is also very likely to be the
    // one we expect, but it could be for someone else.
    const respCseq = parseInt(resp.headers.get("CSeq", "-1"), 10);
    const entry = this.requests.get(respCseq);
    if (entry) {
      this.requests.set(respCseq, [entry[0], resp]);
      entry[0].set();
    }

    // Wait for response to the CSeq we expect
    let response: HttpResponse | null;
    try {
      await waitFor(this.requests.get(cseq)![0].wait(), 4);
      response = this.requests.get(cseq)![1];
    } catch (ex) {
      if (ex instanceof TimeoutError) throw new TimeoutError(`no response to CSeq ${cseq} (${options.uri ?? this.uri})`);
      throw ex;
    } finally {
      this.requests.delete(cseq);
    }

    // Programming error: forgot to store response before activating event
    if (response === null) throw new Error(`no response was saved for ${cseq}`);
    return response;
  }
}
