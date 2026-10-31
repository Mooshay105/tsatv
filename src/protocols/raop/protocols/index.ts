/** Base classes used by streaming protocols. */

import { randomInt } from "node:crypto";
import { type HapCredentials, NO_CREDENTIALS } from "../../../auth/hap_pairing.ts";
import type { HttpResponse } from "../../../support/http.ts";
import { getLogger } from "../../../support/logging.ts";
import { AirPlayAudioFormat } from "../../../settings.ts";
import { FRAMES_PER_PACKET } from "../../../support/rtsp.ts";
import type { Address, DatagramProtocol, DatagramTransport } from "../../../support/transport.ts";
import { TimingPacket } from "../packets.ts";
import * as timing from "../timing.ts";

const LOGGER = getLogger("pyatv.protocols.raop.protocols");

/** Data used for one RAOP session. */
export class StreamContext {
  credentials: HapCredentials = NO_CREDENTIALS;
  password: string | null = null;

  /** Audio format used by AirPlay 2 streams. */
  audioFormat: AirPlayAudioFormat = AirPlayAudioFormat.ALAC;

  sampleRate = 44100;
  channels = 2;
  bytesPerChannel = 2;
  latency = 22050 + this.sampleRate;

  rtpseq = 0;
  startTs = 0;
  headTs = 0;
  paddingSent = 0;

  serverPort = 0;
  eventPort = 0;
  controlPort = 0;
  timingPort = 0;
  rtspSession = 0;

  volume: number | null = null;

  /** Reset session. Must be done when sample rate changes. */
  reset(): void {
    this.rtpseq = randomInt(0, 2 ** 16);
    this.startTs = timing.ntp2ts(timing.ntpNow(), this.sampleRate);
    this.headTs = this.startTs;
    this.latency = 22050 + this.sampleRate;
    this.paddingSent = 0;
  }

  /** Current RTP time with latency. */
  get rtptime(): number {
    return this.headTs - (this.startTs - this.latency);
  }

  /** Current position in stream (seconds with fraction). */
  get position(): number {
    // Do not consider latency here (so do not use rtptime)
    return timing.ts2ms(this.headTs - this.startTs, this.sampleRate) / 1000.0;
  }

  /** Size of a single audio frame. */
  get frameSize(): number {
    return this.channels * this.bytesPerChannel;
  }

  /** Size of a full audio packet. */
  get packetSize(): number {
    return FRAMES_PER_PACKET * this.frameSize;
  }
}

/** Base interface for a streaming protocol. */
export interface StreamProtocol {
  /** To setup connection prior to starting to stream. */
  setup(timingServerPort: number, controlClientPort: number): Promise<void>;

  /** Teardown resources allocated by setup efter streaming finished. */
  teardown(): void;

  /** Start to send feedback (if supported and required). */
  startFeedback(): Promise<void>;

  /** Send audio packet to receiver. Returns [seqno, packet]. */
  sendAudioPacket(transport: DatagramTransport, rtpHeader: Buffer, audio: Buffer): Promise<[number, Buffer]>;

  /** Play media from a URL. */
  playUrl(timingServerPort: number, url: string, position?: number): Promise<HttpResponse>;

  /** Return whether playback state is reported by the stream. */
  readonly supportsPlaybackState?: boolean;

  /** Return playback state reported by the stream, if supported. */
  readonly playbackState?: string | null;

  /** Wait for playback state to change, if supported by the stream. */
  waitForPlaybackStateChange?(previousState: string | null, timeout: number): Promise<string | null>;

  /** Error reported by the receiver during playback (e.g. it could not load the URL). */
  readonly playbackError?: string | null;
}

/** Basic timing server responding to timing requests. */
export class TimingServer implements DatagramProtocol {
  transport: DatagramTransport | null = null;

  close(): void {
    this.transport?.close();
    this.transport = null;
  }

  /** Port this server listens to. */
  get port(): number {
    return this.transport!.getExtraInfo("sockname")[1];
  }

  connectionMade(transport: DatagramTransport): void {
    this.transport = transport;
  }

  datagramReceived(data: Buffer, addr: Address): void {
    const req = TimingPacket.decode(data);
    const [recvtimeSec, recvtimeFrac] = timing.ntp2parts(timing.ntpNow());
    const resp = TimingPacket.encode(
      req.proto,
      0x53 | 0x80,
      7,
      0,
      req.sendtimeSec,
      req.sendtimeFrac,
      recvtimeSec,
      recvtimeFrac,
      recvtimeSec,
      recvtimeFrac,
    );
    this.transport?.sendto(resp, addr);
  }

  errorReceived(exc: Error): void {
    LOGGER.error("Error received: %s", exc);
  }
}
