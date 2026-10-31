/** Implementation of AirPlay v2 protocol logic. */

import { setupChannel } from "../../../auth/hap_channel.ts";
import type { PairVerifyProcedure } from "../../../auth/hap_pairing.ts";
import { InvalidStateError, ProtocolError } from "../../../exceptions.ts";
import { Event, createTask, sleep, type Task, TimeoutError, waitFor } from "../../../support/asyncio.ts";
import { Chacha20Cipher8byteNonce } from "../../../support/chacha20.ts";
import { Float } from "../../../support/float.ts";
import { decodeBplistFromBody, type HttpResponse } from "../../../support/http.ts";
import { getLogger } from "../../../support/logging.ts";
import * as plistlib from "../../../support/plistlib.ts";
import { HTTP_PROTOCOL, type RtspSession } from "../../../support/rtsp.ts";
import type { DatagramTransport, Transport } from "../../../support/transport.ts";
import { uuid4 } from "../../../support/uuid.ts";
import { verifyConnection } from "../../airplay/auth/index.ts";
import { EventChannel } from "../../airplay/channels.ts";
import { AirPlayAudioFormat } from "../../../settings.ts";
import { encodeUncompressedAlac } from "../alac.ts";
import type { StreamContext, StreamProtocol } from "./index.ts";

// Audio formats used in SETUP ("audioFormat" is a bitmask of supported formats)
const AUDIO_FORMAT_PCM_44100_16_2 = 0x800;
const AUDIO_FORMAT_ALAC_44100_16_2 = 0x40000;
const COMPRESSION_TYPE_PCM = 1;
const COMPRESSION_TYPE_ALAC = 2;

const LOGGER = getLogger("pyatv.protocols.raop.protocols.airplayv2");

export const EVENTS_SALT = "Events-Salt";
export const EVENTS_WRITE_INFO = "Events-Write-Encryption-Key";
export const EVENTS_READ_INFO = "Events-Read-Encryption-Key";

export const FEEDBACK_INTERVAL = 2.0; // Seconds

export const COMMAND_USER_AGENT = "AirPlay/870.14.1";
export const REMOTE_CONTROL_CLIENT_TYPE = "A6B27562-B43A-4F2D-B75F-82391E250194";

/** Generate a random, locally administered unicast MAC-style device id. */
function randomSenderDeviceId(): string {
  const bytes = Buffer.from(uuid4().replace(/-/g, "").slice(0, 12), "hex");
  bytes[0] = (bytes[0]! & 0xfc) | 0x02;
  return [...bytes].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":");
}

/** Stream protocol used for AirPlay v2 support. */
export class AirPlayV2 implements StreamProtocol {
  eventTransport: Transport | null = null;
  eventChannel: EventChannel | null = null;
  private _verifier: PairVerifyProcedure | null = null;
  private _cipher: Chacha20Cipher8byteNonce | null = null;
  private _feedbackTask: Task<void> | null = null;
  private _playbackState: string | null = null;
  private _playbackStateChanged = new Event();
  private _playbackError: string | null = null;
  private readonly _sessionId = uuid4().toUpperCase();
  private readonly _senderDeviceId = randomSenderDeviceId();
  private _streamId: number | null = null;

  constructor(
    readonly context: StreamContext,
    readonly rtsp: RtspSession,
  ) {}

  private async _setupBase(timingServerPort: number): Promise<void> {
    this._verifier = await verifyConnection(this.context.credentials, this.rtsp.connection);

    const setupResp = await this.rtsp.setup({
      body: {
        deviceID: this._senderDeviceId,
        sessionUUID: this._sessionId,
        sessionCorrelationUUID: uuid4().toUpperCase(),
        timingPort: timingServerPort,
        timingProtocol: "NTP",
        isMultiSelectAirPlay: true,
        groupContainsGroupLeader: false,
        macAddress: this._senderDeviceId,
        model: "iPhone14,3",
        name: "pyatv",
        osBuildVersion: "20F66",
        osName: "iPhone OS",
        osVersion: "16.5",
        senderSupportsRelay: false,
        sourceVersion: "690.7.1",
        statsCollectionEnabled: false,
      },
    });
    const resp = decodeBplistFromBody(setupResp);
    LOGGER.debug("Setup response body: %s", resp);

    const eventPort = resp.eventPort ?? 0;

    // airplay2-receiver seems to set up the event channel some time after responding
    // with the port used for it. So do some retries here.
    let retries = 5;
    let transport: Transport | null = null;
    let channel: EventChannel | null = null;
    while (transport === null) {
      try {
        [transport, channel] = await setupChannel(
          (out, inp) => new EventChannel(out, inp),
          this._verifier,
          this.rtsp.connection.remoteIp,
          eventPort,
          EVENTS_SALT,
          EVENTS_READ_INFO,
          EVENTS_WRITE_INFO,
        );
      } catch (ex: any) {
        // Python catches (ConnectionRefusedError, OSError), i.e. any socket error
        if (typeof ex?.code !== "string") throw ex;
        retries -= 1;
        if (retries === 0) throw ex;
        LOGGER.debug("Connect failed, retrying");
        await sleep(1.0);
      }
    }
    this.eventTransport = transport;
    this.eventChannel = channel;
    this.eventChannel!.setEventListener((event) => this._handleEvent(event));
  }

  private _handleEvent(event: Record<string, any>): void {
    // The receiver did not load the URL itself and asks us to fetch it on its behalf
    // (FCUP, meant for app specific URL schemes and keys). Seen on tvOS 26 when the
    // URL was not reachable by the device (HTTP 403). Proxying media is not
    // supported, so fail playback instead of waiting for it to start.
    if (event.kind === "request" && event.type === "unhandledURL") {
      const url = event.request?.FCUP_Response_URL ?? "unknown URL";
      LOGGER.debug("Receiver asked sender to load %s (unhandledURL)", url);
      this._playbackError =
        `device could not load ${url} by itself and asked the sender to fetch it (unhandledURL), ` +
        "which is not supported. Make sure the URL is reachable from the device";
      this._playbackStateChanged.set();
      return;
    }

    if (event.type !== "playbackState") return;

    const params = event.params;
    let state = params !== null && typeof params === "object" ? params.playbackState : undefined;
    if (state === undefined || state === null) state = event.name;
    if (typeof state === "string") {
      const normalizedState = state.toLowerCase();
      if (normalizedState !== this._playbackState) {
        this._playbackState = normalizedState;
        this._playbackStateChanged.set();
      }
    }
  }

  async setup(timingServerPort: number, controlClientPort: number): Promise<void> {
    await this._setupBase(timingServerPort);
    await this.setupAudioStream(controlClientPort);
  }

  /** Setup a new stream used for audio. */
  async setupAudioStream(controlClientPort: number): Promise<void> {
    if (this._verifier === null) throw new InvalidStateError("base stream not set up");

    // It doesn't really matter what the key is as it's merely a security feature.
    // For the sake of it, derive a key from event parameters.
    const [outKey] = this._verifier.encryptionKeys(EVENTS_SALT, EVENTS_WRITE_INFO, EVENTS_READ_INFO);
    const sharedSecret = outKey.subarray(0, 32);
    const useAlac = this.context.audioFormat === AirPlayAudioFormat.ALAC;
    LOGGER.debug("Setting up audio stream with format %s", this.context.audioFormat);

    const setupResp = await this.rtsp.setup({
      body: {
        streams: [
          {
            audioFormat: useAlac ? AUDIO_FORMAT_ALAC_44100_16_2 : AUDIO_FORMAT_PCM_44100_16_2,
            audioMode: "default",
            controlPort: controlClientPort,
            ct: useAlac ? COMPRESSION_TYPE_ALAC : COMPRESSION_TYPE_PCM,
            isMedia: true,
            latencyMax: 88200,
            latencyMin: 11025,
            shk: sharedSecret,
            spf: 352, // Samples Per Frame
            sr: 44100, // Sample rate
            type: 0x60,
            supportsDynamicStreamID: false,
            streamConnectionID: this.rtsp.sessionId,
          },
        ],
      },
    });
    const resp = decodeBplistFromBody(setupResp);
    LOGGER.debug("Setup stream response: %s", resp);

    const stream = resp.streams[0];
    this.context.controlPort = stream.controlPort;
    this.context.serverPort = stream.dataPort;

    this._cipher = new Chacha20Cipher8byteNonce(sharedSecret, sharedSecret);
  }

  teardown(): void {
    this._feedbackTask?.cancel();
    this._feedbackTask = null;
    this.eventTransport?.close();
    this.eventTransport = null;
    this.eventChannel = null;
  }

  async startFeedback(): Promise<void> {
    if (this._feedbackTask === null) {
      this._feedbackTask = createTask((signal) => this._feedbackTaskLoop(signal));
      this._feedbackTask.promise.catch(() => undefined);
    }
  }

  private async _feedbackTaskLoop(signal: AbortSignal): Promise<void> {
    LOGGER.debug("Starting feedback task");
    while (!signal.aborted) {
      try {
        await this.rtsp.feedback();
      } catch (ex) {
        // Treat feedback as "best effort" and don't raise any errors
        LOGGER.debug("Feedback failed: %s", ex);
      }
      await sleep(FEEDBACK_INTERVAL);
    }
  }

  async sendAudioPacket(transport: DatagramTransport, rtpHeader: Buffer, audio: Buffer): Promise<[number, Buffer]> {
    let nonce: Buffer = Buffer.alloc(0);
    let payload =
      this.context.audioFormat === AirPlayAudioFormat.ALAC ? encodeUncompressedAlac(audio, this.context.channels) : audio;
    if (this._cipher) {
      // Save the nonce that will be used by the next encrypt call as it is included in
      // the audio packet.
      nonce = this._cipher.outNonce;
      const aad = rtpHeader.subarray(4, 12);
      payload = this._cipher.encrypt(payload, null, aad);
    }

    // Only eight byte nonces are used for encryption
    const packet = Buffer.concat([rtpHeader, payload, nonce.subarray(nonce.length - 8)]);
    transport.sendto(packet);
    return [this.context.rtpseq, packet];
  }

  private async _setupUrlStream(): Promise<void> {
    const response = await this.rtsp.setup({
      body: {
        streams: [
          {
            clientUUID: uuid4().toUpperCase(),
            clientTypeUUID: REMOTE_CONTROL_CLIENT_TYPE,
            channelID: `${this._senderDeviceId}-RCS-1`,
            controlType: 1,
            type: 130,
          },
        ],
      },
    });
    const payload = decodeBplistFromBody(response);
    const streams = payload?.streams ?? [];
    if (streams.length === 0 || streams[0]?.streamID === undefined) {
      throw new ProtocolError("missing URL control stream in SETUP response");
    }
    this._streamId = Number(streams[0].streamID);
  }

  private async _sendUrlCommand(command: Record<string, unknown>): Promise<HttpResponse> {
    if (this._streamId === null) throw new InvalidStateError("URL control stream not set up");

    const body = {
      params: { data: plistlib.dumps(command, { fmt: plistlib.FMT_BINARY, sortKeys: false }) },
    };
    return this.rtsp.exchange("POST", {
      uri: "/command",
      protocol: HTTP_PROTOCOL,
      headers: {
        "User-Agent": COMMAND_USER_AGENT,
        "X-Apple-ProtocolVersion": "1",
        "X-Apple-Session-ID": this._sessionId,
        "X-Apple-StreamID": String(this._streamId),
      },
      body,
      allowError: true,
    });
  }

  /** Play media from a URL. */
  async playUrl(timingServerPort: number, url: string, position = 0.0): Promise<HttpResponse> {
    this._playbackError = null;
    if (this._verifier === null) {
      await this._setupBase(timingServerPort);
      await this.startFeedback();
    }
    await this.rtsp.info();
    await this.rtsp.record();
    await this._setupUrlStream();

    const item = {
      uuid: uuid4().toUpperCase(),
      mediaType: "file",
      "Content-Location": url,
      "Start-Position-Seconds": new Float(position),
    };
    const commands: Array<Record<string, unknown>> = [
      { type: "insertPlayQueueItem", item },
      { type: "setProperty", value: true, property: "isInterestedInDateRange", item: { uuid: item.uuid } },
      { type: "setProperty", value: 1, property: "actionAtItemEnd" },
      { type: "setRate", rate: new Float(1.0) },
    ];

    let response: HttpResponse | null = null;
    for (const command of commands) {
      response = await this._sendUrlCommand(command);
      if (response.code < 200 || response.code >= 300) return response;
    }
    return response!;
  }

  /** Return whether playback state is reported by this stream. */
  get supportsPlaybackState(): boolean {
    return true;
  }

  /** Return the latest playback state from the event channel. */
  get playbackState(): string | null {
    return this._playbackState;
  }

  /** Return error reported by the receiver during playback (if any). */
  get playbackError(): string | null {
    return this._playbackError;
  }

  /** Wait for the event channel to report a new playback state. */
  async waitForPlaybackStateChange(previousState: string | null, timeout: number): Promise<string | null> {
    this._playbackStateChanged.clear();
    if (this._playbackState !== previousState) return this._playbackState;
    try {
      await waitFor(this._playbackStateChanged.wait(), timeout);
    } catch (ex) {
      if (!(ex instanceof TimeoutError)) throw ex;
    }
    return this._playbackState;
  }
}
