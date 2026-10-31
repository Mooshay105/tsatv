/** Fake RAOP device for tests. */

import { createHash, randomInt } from "node:crypto";
import { Protocol } from "../../src/const.ts";
import { MediaMetadata } from "../../src/interface.ts";
import * as parser from "../../src/protocols/dmap/parser.ts";
import { lookupTag } from "../../src/protocols/dmap/tag_definitions.ts";
import { RetransmitReqeust, RtpHeader, SyncPacket } from "../../src/protocols/raop/packets.ts";
import { parseTransport } from "../../src/protocols/raop/protocols/airplayv1.ts";
import { Float } from "../../src/support/float.ts";
import { BasicHttpServer, HttpRequest, HttpResponse, HttpSimpleRouter, httpServer } from "../../src/support/http.ts";
import { getLogger } from "../../src/support/logging.ts";
import * as plistlib from "../../src/support/plistlib.ts";
import {
  type Address,
  createDatagramEndpoint,
  type DatagramProtocol,
  type DatagramTransport,
  type Server,
} from "../../src/support/transport.ts";
import { registerFake } from "./index.ts";
import type { WebApp } from "./web.ts";

const LOGGER = getLogger("tests.fake_device.raop");

export const INITIAL_VOLUME = -15.0;

const REALM = "raop";

/** Flags used to alter fake service behavior. */
export enum RaopServiceFlags {
  EMPTY = 1,
  /** If /info endpoint is supported. */
  INFO_SUPPORTED = 2,
  /** If authentication is required or not. */
  AUTH_REQUIRED = 4,
  /** If audio packet retransmission is supported. */
  SUPPORTS_RETRANSMISSION = 8,
  /** If initial audio level is supported. */
  INITIAL_AUDIO_LEVEL = 16,
  /** If feedback is supported. */
  FEEDBACK_SUPPORTED = 32,
  /**
   * Fail to set volume prior to start start.
   *
   * Some devices (at least Sonos) seems to fail when setting volume prior to starting a
   * stream. This flag mimics that behavior.
   */
  DELAYED_SET_VOLUME = 64,
}

const md5 = (text: string) => createHash("md5").update(text, "utf-8").digest("hex");

const textOf = (request: HttpRequest) => (Buffer.isBuffer(request.body) ? request.body.toString("utf-8") : request.body);
const bytesOf = (request: HttpRequest) => (Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body, "utf-8"));

function rtspResponse(request: HttpRequest, code: number, message: string, headers: Record<string, string> = {}, body: Buffer = Buffer.alloc(0)) {
  return new HttpResponse("RTSP", "1.0", code, message, { CSeq: request.headers.get("CSeq", ""), ...headers }, body);
}

/** Internal state for RAOP service. */
export class FakeRaopState {
  flags: number = RaopServiceFlags.INFO_SUPPORTED | RaopServiceFlags.FEEDBACK_SUPPORTED;
  metadata = new MediaMetadata();
  audioPackets = new Map<number, Buffer>(); // seqno -> raw audio
  initialAudioPacket: number | null = null;
  password: string | null = null;
  nonce: string | null = null;
  authSetupPerformed = false;
  feedbackPacketsReceived = 0;
  syncPacketsReceived = 0;
  dropPackets = 0;
  controlPort = 0;
  remoteAddress: string | null = null;
  volume: number = INITIAL_VOLUME;
  teardownCalled = false;
  streamingStarted = false;

  /** Return if a feature is supported. */
  isSupported(flag: RaopServiceFlags): boolean {
    return (this.flags & flag) !== 0;
  }

  /** Set if a feature is supported or not. */
  setFlagState(flag: RaopServiceFlags, enabled: boolean): void {
    if (enabled) this.flags |= flag;
    else this.flags &= ~flag;
  }

  get rawAudio(): Buffer {
    if (this.audioPackets.size === 0) return Buffer.alloc(0);

    // We don't care about the order in which packets was received as that is supposed
    // to be sorted out by the receiver. So we sort packet sequence numbers (and thus
    // also audio data). Since sequence numbers are 16 bits, a wrap-around might happen.
    // So look the first received packet and then re-arrange everything so that comes
    // first (basically iterate from that index) and merge audio data after that.
    const sortedPackets = [...this.audioPackets.keys()].sort((a, b) => a - b);
    const startIndex = sortedPackets.indexOf(this.initialAudioPacket!);
    const indices = [...sortedPackets.slice(startIndex), ...sortedPackets.slice(0, startIndex)];
    return Buffer.concat(indices.map((index) => this.audioPackets.get(index)!));
  }

  addAudioPacket(seqno: number, audioData: Buffer): void {
    // Save sequence number of first packet since it can wrap (16 bit)
    if (this.initialAudioPacket === null) {
      this.initialAudioPacket = seqno;
      LOGGER.debug("Saving initial audio packet seqno %d", seqno);
    }
    this.audioPackets.set(seqno, Buffer.from(audioData));
  }

  resetStreaming(): void {
    this.metadata = new MediaMetadata();
    this.streamingStarted = false;
  }
}

abstract class UdpServer implements DatagramProtocol {
  transport: DatagramTransport | null = null;

  close(): void {
    this.transport?.close();
    this.transport = null;
  }

  /** Port this server listens on. */
  get port(): number {
    return this.transport!.getExtraInfo("sockname")[1];
  }

  connectionMade(transport: DatagramTransport): void {
    this.transport = transport;
  }

  errorReceived(exc: Error): void {
    this.transport?.close();
    LOGGER.error("%s receive error: %s", this.constructor.name, exc);
  }

  connectionLost(exc: Error | null): void {
    LOGGER.debug("%s lost connection (%s)", this.constructor.name, exc);
  }
}

/** Protocol used to receive audio packets. */
export class AudioReceiver extends UdpServer {
  constructor(readonly state: FakeRaopState) {
    super();
  }

  /** Reset audio receiver. */
  reset(): void {
    this.state.audioPackets = new Map();
    this.state.initialAudioPacket = null;
  }

  datagramReceived(data: Buffer, addr: Address): void {
    LOGGER.debug("Received audio packet from %s: %s...", addr, data.subarray(0, 32));

    const header = RtpHeader.decode(data, true);
    const packetType = header.type & 0x7f; // Remove marker bit

    if (packetType === 0x60) {
      // Normal packet. Drop packet if requested (only for normal packets).
      if (this.state.dropPackets > 0) {
        LOGGER.debug("Dropping packet (%d) %d", header.seqno, this.state.dropPackets);
        this.state.dropPackets -= 1;

        if (this.state.isSupported(RaopServiceFlags.SUPPORTS_RETRANSMISSION)) {
          LOGGER.debug("Requesting to retransmit seqno %d", header.seqno);
          this._requestRetransmit(data, [this.state.remoteAddress!, this.state.controlPort]);
        }
      } else {
        this.state.addAudioPacket(header.seqno, data.subarray(12));
      }
    } else if (packetType === 0x56) {
      // Retransmission
      const originalPacket = data.subarray(4); // Remove retransmission header
      this.state.addAudioPacket(header.seqno, originalPacket.subarray(12));
    } else {
      LOGGER.debug("Unhandled packet type: %d", packetType);
    }
  }

  private _requestRetransmit(data: Buffer, addr: Address): void {
    const header = RtpHeader.decode(data, true);
    const packet = RetransmitReqeust.encode(
      0x80, // Header
      0x55 | 0x80, // 0x55 = retransmit, 0x80 = marker bit
      0, // Sequence number in RTP header not used(?)
      header.seqno, // Sequence number of missing packet
      1, // Ask for one packet
    );
    this.transport?.sendto(packet, addr);
    LOGGER.debug("Sent %s to %s", packet, addr);
  }
}

/** Protocol used for time synchronization. */
export class FakeTimingServer extends UdpServer {
  datagramReceived(data: Buffer, _addr: Address): void {
    LOGGER.debug("Received timing packet: %s", data);
  }
}

/** Protocol used for control channel. */
export class ControlServer extends UdpServer {
  constructor(readonly state: FakeRaopState) {
    super();
  }

  datagramReceived(data: Buffer, _addr: Address): void {
    LOGGER.debug("Received control packet: %s", data);
    // TODO: Only decoding now, should verify some stuff as well
    SyncPacket.decode(data);
    this.state.syncPacketsReceived += 1;
  }
}

type Handler = (request: HttpRequest) => HttpResponse;

/** Implementation of a fake RAOP device. */
export class FakeRaopService extends HttpSimpleRouter {
  server: Server | null = null;
  port = 0;
  private _audioReceiver: AudioReceiver | null = null;
  private _timingServer: FakeTimingServer | null = null;
  private _controlServer: ControlServer | null = null;

  constructor(
    readonly state: FakeRaopState,
    readonly app: WebApp | null = null,
  ) {
    super();
    const guarded = (handler: Handler) => this.requiresAuth(this.verifyPassword(handler));
    this.addRoute("ANNOUNCE", "rtsp://.*", guarded((r) => this.handleAnnounce(r)));
    this.addRoute("SETUP", "rtsp://*", guarded((r) => this.handleSetup(r)));
    this.addRoute("SET_PARAMETER", "rtsp://*", guarded((r) => this.handleSetParameter(r)));
    this.addRoute("POST", "/feedback", guarded((r) => this.handleFeedback(r)));
    this.addRoute("RECORD", "rtsp://*", guarded((r) => this.handleRecord(r)));
    this.addRoute("POST", "/auth-setup", this.verifyPassword((r) => this.handleAuthSetup(r)));
    this.addRoute("GET", "/info", (r) => this.handleInfo(r));
    this.addRoute("TEARDOWN", "rtsp://*", (r) => this.handleTeardown(r));
    this.addRoute("FLUSH", "rtsp://*", guarded((r) => this.handleFlush(r)));
  }

  private requiresAuth(method: Handler): Handler {
    return (request) => {
      if (this.state.isSupported(RaopServiceFlags.AUTH_REQUIRED) && !this.state.authSetupPerformed) {
        return rtspResponse(request, 403, "Forbidden");
      }
      return method(request);
    };
  }

  private verifyPassword(method: Handler): Handler {
    return (request) => {
      // No password required
      if (!this.state.password) return method(request);

      // Send a challenge
      if (!this.state.nonce) {
        const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        const nonce = Array.from({ length: 32 }, () => chars[randomInt(chars.length)]).join("");
        this.state.nonce = nonce;
        return rtspResponse(request, 401, "Unauthorized", { "WWW-Authenticate": `Digest realm="${REALM}", nonce="${nonce}"` });
      }

      // Verify the authentication payload send by the client
      const payloadData = request.headers.get("Authorization", "").split('"');
      if (payloadData.length === 11) {
        const uri = request.path;
        const user = payloadData[1];
        const actualResponse = payloadData[9];
        const ha1 = md5(`${user}:${REALM}:${this.state.password}`);
        const ha2 = md5(`${request.method}:${uri}`);
        const expectedResponse = md5(`${ha1}:${this.state.nonce}:${ha2}`);
        if (actualResponse === expectedResponse) return method(request);
      }

      // Password verification failed
      return rtspResponse(request, 401, "Unauthorized");
    };
  }

  /** Start the fake RAOP service. */
  async start(_startWebServer: boolean): Promise<void> {
    [this.server, this.port] = await httpServer(() => new BasicHttpServer(this), "0.0.0.0");

    const localAddr: Address = ["0.0.0.0", 0];
    [, this._audioReceiver] = await createDatagramEndpoint(() => new AudioReceiver(this.state), { localAddr });
    [, this._timingServer] = await createDatagramEndpoint(() => new FakeTimingServer(), { localAddr });
    [, this._controlServer] = await createDatagramEndpoint(() => new ControlServer(this.state), { localAddr });

    LOGGER.debug(
      "Started RAOP server: port=%d, audio=%d, timing=%d, control=%d",
      this.port,
      this._audioReceiver.port,
      this._timingServer.port,
      this._controlServer.port,
    );
  }

  /** Clean up resources used by fake RAOP service. */
  async cleanup(): Promise<void> {
    this.server?.close();
    this._audioReceiver?.close();
    this._timingServer?.close();
    this._controlServer?.close();
  }

  /** Handle incoming ANNOUNCE request. */
  handleAnnounce(request: HttpRequest): HttpResponse {
    LOGGER.debug("Received ANNOUNCE: %s", request);
    for (const line of textOf(request).split("\r\n")) {
      if (line.startsWith("o=")) {
        this.state.remoteAddress = line.split(/\s+/).pop()!;
        break;
      }
    }
    return rtspResponse(request, 200, "OK");
  }

  /** Handle incoming SETUP request. */
  handleSetup(request: HttpRequest): HttpResponse {
    LOGGER.debug("Received SETUP: %s", request);
    const [, options] = parseTransport(request.headers.get("Transport", ""));
    this.state.controlPort = parseInt(options.control_port!, 10);
    this.state.resetStreaming();
    this._audioReceiver!.reset();
    return rtspResponse(request, 200, "OK", {
      Transport:
        "RTP/AVP/UDP;unicast;mode=record;" +
        `server_port=${this._audioReceiver!.port};` +
        `control_port=${this._controlServer!.port};` +
        `timing_port=${this._timingServer!.port}`,
      Session: "1",
    });
  }

  /** Handle incoming SET_PARAMETER request. */
  handleSetParameter(request: HttpRequest): HttpResponse {
    LOGGER.debug("Received SET_PARAMETER: %s", request);
    const contentType = request.headers.get("Content-Type");
    if (contentType === "application/x-dmap-tagged") {
      const tags = parser.parse(bytesOf(request), lookupTag);
      this.state.metadata.title = parser.first(tags, "mlit", "minm");
      this.state.metadata.artist = parser.first(tags, "mlit", "asar");
      this.state.metadata.album = parser.first(tags, "mlit", "asal");
    } else if (contentType !== "image/jpeg" && textOf(request).startsWith("volume:")) {
      // If delayed set volume is active, then streaming must have started
      if (this.state.isSupported(RaopServiceFlags.DELAYED_SET_VOLUME) && !this.state.streamingStarted) {
        return rtspResponse(request, 500, "Not supported here");
      }
      this.state.volume = parseFloat(textOf(request).split(" ").slice(1).join(" "));
      LOGGER.debug("Changing volume to %f", this.state.volume);
    } else if (contentType === "image/jpeg") {
      this.state.metadata.artwork = bytesOf(request);
      LOGGER.debug("Got artwork (%d bytes)", this.state.metadata.artwork.length);
    } else {
      return rtspResponse(request, 501, "Not implemented");
    }
    return rtspResponse(request, 200, "OK");
  }

  /** Handle incoming feedback request. */
  handleFeedback(request: HttpRequest): HttpResponse {
    LOGGER.debug("Received feedback: %s", request);
    this.state.feedbackPacketsReceived += 1;
    if (!this.state.isSupported(RaopServiceFlags.FEEDBACK_SUPPORTED)) {
      return rtspResponse(request, 501, "Not implemented");
    }
    return rtspResponse(request, 200, "OK");
  }

  /** Handle incoming RECORD request. */
  handleRecord(request: HttpRequest): HttpResponse {
    LOGGER.debug("Received RECORD: %s", request);
    return rtspResponse(request, 200, "OK");
  }

  /** Handle incoming FLUSH request. */
  handleFlush(request: HttpRequest): HttpResponse {
    LOGGER.debug("Received FLUSH: %s", request);
    this.state.streamingStarted = true;
    return rtspResponse(request, 200, "OK");
  }

  /** Handle incoming auth-setup request. */
  handleAuthSetup(request: HttpRequest): HttpResponse {
    LOGGER.debug("Received auth-setup: %s", request);
    // Just check if decent sized payload is there
    if (bytesOf(request).length === 1 + 32) {
      // auth type + public key
      this.state.authSetupPerformed = true;
      return rtspResponse(request, 200, "OK");
    }
    return rtspResponse(request, 403, "Forbidden");
  }

  /** Handle incoming info request. */
  handleInfo(request: HttpRequest): HttpResponse {
    if (!this.state.isSupported(RaopServiceFlags.INFO_SUPPORTED)) {
      return rtspResponse(request, 400, "Bad Request");
    }
    const info: Record<string, unknown> = {};
    if (this.state.isSupported(RaopServiceFlags.INITIAL_AUDIO_LEVEL)) info.initialVolume = new Float(this.state.volume);
    return rtspResponse(request, 200, "OK", { "content-type": "application/x-apple-binary-plist" }, plistlib.dumps(info));
  }

  /** Handle incoming TEARDOWN request. */
  handleTeardown(request: HttpRequest): HttpResponse {
    this.state.teardownCalled = true;
    return rtspResponse(request, 200, "OK");
  }
}

/** Wrapper for altering behavior of a FakeRaopService instance. */
export class FakeRaopUseCases {
  constructor(readonly state: FakeRaopState) {}

  /** Enable or disable retransmissions. */
  retransmissionsEnabled(enabled: boolean): void {
    this.state.setFlagState(RaopServiceFlags.SUPPORTS_RETRANSMISSION, enabled);
  }

  /** Make fake device drop packets and trigger retransmission (if supported). */
  dropNPackets(packets: number): void {
    this.state.dropPackets = packets;
  }

  /** Enable or disable support for /feedback endpoint. */
  feedbackEnabled(enabled: boolean): void {
    this.state.setFlagState(RaopServiceFlags.FEEDBACK_SUPPORTED, enabled);
  }

  /** Initial audio level reported in info from device. */
  initialAudioLevelSupported(supported: boolean): void {
    this.state.setFlagState(RaopServiceFlags.INITIAL_AUDIO_LEVEL, supported);
  }

  /** Enable or disable requirement to perform authentication. */
  requireAuth(isRequired: boolean): void {
    this.state.setFlagState(RaopServiceFlags.AUTH_REQUIRED, isRequired);
  }

  /** Set a new password. Pass in null to remove the password. */
  password(newPassword: string | null): void {
    this.state.password = newPassword;
    this.state.nonce = null;
  }

  /** State if /info is supported or not. */
  supportsInfo(isSupported: boolean): void {
    this.state.setFlagState(RaopServiceFlags.INFO_SUPPORTED, isSupported);
  }

  /** Enable or disable delayed set volume. */
  delayedSetVolume(delayedSetVolume: boolean): void {
    this.state.setFlagState(RaopServiceFlags.DELAYED_SET_VOLUME, delayedSetVolume);
  }
}

registerFake(
  Protocol.RAOP,
  (state, app) => new FakeRaopService(state, app),
  () => new FakeRaopState(),
  (state) => new FakeRaopUseCases(state),
);
