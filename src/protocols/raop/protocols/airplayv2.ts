/** Implementation of AirPlay v2 protocol logic. */

import { setupChannel } from "../../../auth/hap_channel.ts";
import type { PairVerifyProcedure } from "../../../auth/hap_pairing.ts";
import { InvalidStateError } from "../../../exceptions.ts";
import { createTask, sleep, type Task } from "../../../support/asyncio.ts";
import { Chacha20Cipher8byteNonce } from "../../../support/chacha20.ts";
import { Float } from "../../../support/float.ts";
import { decodeBplistFromBody, type HttpResponse } from "../../../support/http.ts";
import { getLogger } from "../../../support/logging.ts";
import * as plistlib from "../../../support/plistlib.ts";
import type { RtspSession } from "../../../support/rtsp.ts";
import type { DatagramTransport, Transport } from "../../../support/transport.ts";
import { uuid4 } from "../../../support/uuid.ts";
import { verifyConnection } from "../../airplay/auth/index.ts";
import { EventChannel } from "../../airplay/channels.ts";
import type { StreamContext, StreamProtocol } from "./index.ts";

const LOGGER = getLogger("pyatv.protocols.raop.protocols.airplayv2");

export const EVENTS_SALT = "Events-Salt";
export const EVENTS_WRITE_INFO = "Events-Write-Encryption-Key";
export const EVENTS_READ_INFO = "Events-Read-Encryption-Key";

export const FEEDBACK_INTERVAL = 2.0; // Seconds

const HEADERS = {
  "User-Agent": "AirPlay/550.10",
  "Content-Type": "application/x-apple-binary-plist",
  "X-Apple-ProtocolVersion": "1",
  "X-Apple-Session-ID": uuid4().toLowerCase(),
  "X-Apple-Stream-ID": "1",
};

/** Stream protocol used for AirPlay v2 support. */
export class AirPlayV2 implements StreamProtocol {
  eventChannel: Transport | null = null;
  private _verifier: PairVerifyProcedure | null = null;
  private _cipher: Chacha20Cipher8byteNonce | null = null;
  private _feedbackTask: Task<void> | null = null;
  readonly uuid = uuid4();

  constructor(
    readonly context: StreamContext,
    readonly rtsp: RtspSession,
  ) {}

  private async _setupBase(timingServerPort: number): Promise<void> {
    this._verifier = await verifyConnection(this.context.credentials, this.rtsp.connection);

    const setupResp = await this.rtsp.setup({
      body: {
        deviceID: "AA:BB:CC:DD:EE:FF",
        sessionUUID: uuid4().toUpperCase(),
        timingPort: timingServerPort,
        timingProtocol: "NTP",
        isMultiSelectAirPlay: true,
        groupContainsGroupLeader: false,
        macAddress: "AA:BB:CC:DD:EE:FF",
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
    while (transport === null) {
      try {
        [transport] = await setupChannel(
          (out, inp) => new EventChannel(out, inp),
          this._verifier,
          this.rtsp.connection.remoteIp,
          eventPort,
          EVENTS_SALT,
          EVENTS_READ_INFO,
          EVENTS_WRITE_INFO,
        );
      } catch (ex: any) {
        if (ex?.code !== "ECONNREFUSED") throw ex;
        retries -= 1;
        if (retries === 0) throw ex;
        LOGGER.debug("Connect failed, retrying");
        await sleep(1.0);
      }
    }
    this.eventChannel = transport;
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

    const setupResp = await this.rtsp.setup({
      body: {
        streams: [
          {
            audioFormat: 0x800,
            audioMode: "default",
            controlPort: controlClientPort,
            ct: 1, // Raw PCM
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
    this.eventChannel?.close();
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
    let payload = audio;
    if (this._cipher) {
      // Save the nonce that will be used by the next encrypt call as it is included in
      // the audio packet.
      nonce = this._cipher.outNonce;
      const aad = rtpHeader.subarray(4, 12);
      payload = this._cipher.encrypt(audio, null, aad);
    }

    // Only eight byte nonces are used for encryption
    const packet = Buffer.concat([rtpHeader, payload, nonce.subarray(nonce.length - 8)]);
    transport.sendto(packet);
    return [this.context.rtpseq, packet];
  }

  async playUrl(timingServerPort: number, url: string, position = 0.0): Promise<HttpResponse> {
    await this._setupBase(timingServerPort);
    await this.startFeedback();
    await this.rtsp.record();

    // Most fields are not needed here, but keeping them for reference
    const body = {
      "Content-Location": url,
      "Start-Position-Seconds": new Float(position),
      uuid: this.uuid,
      streamType: 1,
      mediaType: "file",
      mightSupportStorePastisKeyRequests: true,
      playbackRestrictions: 0,
      secureConnectionMs: 22,
      volume: new Float(1.0),
      infoMs: 122,
      connectMs: 18,
      authMs: 0,
      bonjourMs: 0,
      referenceRestrictions: 3,
      SenderMACAddress: "AA:BB:CC:DD:EE:FF",
      model: "iPhone14,3",
      postAuthMs: 0,
      clientBundleID: "dev.pyatv.GPU",
      clientProcName: "dev.pyatv.GPU",
      osBuildVersion: "20G1116",
      rate: new Float(1.0),
    };

    // Actually start the stream
    const resp = await this.rtsp.connection.post("/play", {
      headers: HEADERS,
      body: plistlib.dumps(body, plistlib.FMT_BINARY),
      allowError: true,
    });

    // Most important command is "/rate" as that sets playback rate to 100% (will start
    // paused otherwise).
    await this.rtsp.exchange("PUT", { uri: "/setProperty?isInterestedInDateRange", body: { value: true } });
    await this.rtsp.exchange("PUT", { uri: "/setProperty?actionAtItemEnd", body: { value: 0 } });
    await this.rtsp.exchange("POST", { uri: "/rate?value=1.000000" });
    await this.rtsp.exchange("PUT", {
      uri: "/setProperty?forwardEndTime",
      body: { value: { flags: 0, value: 0, epoch: 0, timescale: 0 } },
    });
    await this.rtsp.exchange("PUT", {
      uri: "/setProperty?reverseEndTime",
      body: { value: { flags: 0, value: 0, epoch: 0, timescale: 0 } },
    });
    return resp;
  }
}
