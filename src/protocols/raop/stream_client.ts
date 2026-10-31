/**
 * Client for AirPlay audio streaming.
 *
 * This is a "generic" client designed around how AirPlay works in regards to streaming.
 * The client uses an underlying "protocol" for protocol specific bits, i.e. to support
 * AirPlay v1 and/or v2. This is mainly for code reuse purposes.
 */

import { AuthenticationError, ProtocolError } from "../../exceptions.ts";
import type { MediaMetadata } from "../../interface.ts";
import type { Settings } from "../../settings.ts";
import { abortableSleep, CancelledError, createTask, sleep, type Task } from "../../support/asyncio.ts";
import { logBinary } from "../../support/index.ts";
import { getLogger } from "../../support/logging.ts";
import { emptyMetadata, metadataEquals, EMPTY_METADATA } from "../../support/metadata.ts";
import { FRAMES_PER_PACKET, type RtspSession } from "../../support/rtsp.ts";
import { type Address, createDatagramEndpoint, type DatagramProtocol, type DatagramTransport } from "../../support/transport.ts";
import { pctToDbfs } from "../airplay/utils.ts";
import type { AudioSource } from "./audio_source.ts";
import { PacketFifo } from "./fifo.ts";
import { AudioPacketHeader, RetransmitReqeust, SyncPacket } from "./packets.ts";
import { EncryptionType, getAudioProperties, getEncryptionTypes, getMetadataTypes, MetadataType } from "./parsers.ts";
import { type StreamContext, type StreamProtocol, TimingServer } from "./protocols/index.ts";
import * as timing from "./timing.ts";
import { MediaMetadata as Metadata } from "../../interface.ts";

const LOGGER = getLogger("pyatv.protocols.raop.stream_client");

// When being late, compensate by sending at most these many packets to catch up
const MAX_PACKETS_COMPENSATE = 3;

// We should store this many packets in case retransmission is requested
const PACKET_BACKLOG_SIZE = 1000;

// Number of "too slow to keep up" warnings to suppress before warning about them
const SLOW_WARNING_THRESHOLD = 5;

// Metadata used when no metadata is present
export const MISSING_METADATA = new Metadata({ title: "Streaming with pyatv", artist: "pyatv", album: "AirPlay", duration: 0.0 });

const SUPPORTED_ENCRYPTIONS = EncryptionType.Unencrypted | EncryptionType.MFiSAP;

const monotonic = () => performance.now() / 1000;
const monotonicNs = () => process.hrtime.bigint();

/** Information for what is currently playing. */
export interface PlaybackInfo {
  metadata: MediaMetadata;
  position: number;
}

/** Control client responsible for e.g. sync packets. */
export class ControlClient implements DatagramProtocol {
  transport: DatagramTransport | null = null;
  task: Task<void> | null = null;

  constructor(
    readonly context: StreamContext,
    readonly packetBacklog: PacketFifo<Buffer>,
  ) {}

  /** Close control client. */
  close(): void {
    if (this.transport) {
      this.transport.close();
      this.transport = null;
    }
  }

  /** Port this control client listens to. */
  get port(): number {
    return this.transport!.getExtraInfo("sockname")[1];
  }

  /** Start sending periodic sync messages. */
  start(addr: string): void {
    LOGGER.debug("Starting periodic sync task");
    if (this.task) throw new Error("already running");

    this.task = createTask(async (signal) => {
      try {
        await this._syncTask([addr, this.context.controlPort], signal);
      } catch (ex) {
        if (!(ex instanceof CancelledError)) LOGGER.exception("control task failure");
      }
      LOGGER.debug("Periodic sync task ended");
    });
  }

  private async _syncTask(dest: Address, signal: AbortSignal): Promise<void> {
    if (this.transport === null) throw new Error("socket not connected");

    let firstPacket = true;
    let currentTime = timing.ts2ntp(this.context.headTs, this.context.sampleRate);
    while (this.transport !== null && !signal.aborted) {
      const [currentSec, currentFrac] = timing.ntp2parts(currentTime);
      const packet = SyncPacket.encode(
        firstPacket ? 0x90 : 0x80,
        0xd4,
        0x0007,
        this.context.rtptime - this.context.latency,
        currentSec,
        currentFrac,
        this.context.rtptime,
      );

      logBinary(LOGGER, "Sending sync packet", {
        SyncPacket: packet,
        Sec: currentSec,
        Frac: currentFrac,
        RtpTime: this.context.rtptime,
      });

      firstPacket = false;
      this.transport.sendto(packet, dest);

      await abortableSleep(1.0, signal); // Very low granularity here
      currentTime = timing.ts2ntp(this.context.headTs, this.context.sampleRate);
    }
  }

  /** Stop control client. */
  stop(): void {
    if (this.task) {
      this.task.cancel();
      this.task = null;
    }
  }

  connectionMade(transport: DatagramTransport): void {
    this.transport = transport;
  }

  /** Handle incoming control data. */
  datagramReceived(data: Buffer, addr: Address): void {
    const actualType = data[1]! & 0x7f; // Remove marker bit

    if (actualType === 0x55) {
      this._retransmitLostPackets(RetransmitReqeust.decode(data), addr);
    } else {
      LOGGER.debug("Received unhandled control data from %s: %s", addr, data);
    }
  }

  private _retransmitLostPackets(request: { lostSeqno: number; lostPackets: number }, addr: Address): void {
    LOGGER.debug("%s from %s", request, addr);

    for (let i = 0; i < request.lostPackets; i++) {
      if (this.packetBacklog.has(request.lostSeqno + i)) {
        const packet = this.packetBacklog.get(request.lostSeqno + i);

        // Very "low level" here just because it's simple and avoids unnecessary
        // conversions
        const originalSeqno = packet.subarray(2, 4);
        const resp = Buffer.concat([Buffer.from([0x80, 0xd6]), originalSeqno, packet]);
        this.transport?.sendto(resp, addr);
      } else {
        LOGGER.debug("Packet %d not in backlog", request.lostSeqno + 1);
      }
    }
  }

  errorReceived(exc: Error): void {
    LOGGER.error("Control connection error: %s", exc);
  }

  connectionLost(exc: Error | null): void {
    LOGGER.debug("Control connection lost (%s)", exc);
    if (this.task) {
      this.task.cancel();
      this.task = null;
    }
  }
}

/** Minimal protocol to send audio packets. */
class AudioProtocol implements DatagramProtocol {
  transport: DatagramTransport | null = null;

  connectionMade(transport: DatagramTransport): void {
    this.transport = transport;
  }

  // No data should ever be seen here
  datagramReceived(_data: Buffer, _addr: Address): void {}

  errorReceived(exc: Error): void {
    this.transport?.close();
    LOGGER.error("Audio error received: %s", exc);
  }

  connectionLost(exc: Error | null): void {
    LOGGER.debug("Audio connection lost (%s)", exc);
  }
}

/** Listener interface for RAOP state changes. */
export interface RaopListener {
  /** Media started playing with metadata. */
  playing(playbackInfo: PlaybackInfo): void;

  /** Media stopped playing. */
  stopped(): void;
}

/** Maintains statistics of frames during a streaming session. */
export class Statistics {
  readonly startTimeNs: bigint = monotonicNs();
  intervalTime: number = monotonic();
  totalFrames = 0;
  intervalFrames = 0;

  constructor(readonly sampleRate: number) {}

  /** Number of frames expected to be sent at current time. */
  get expectedFrameCount(): number {
    return Math.trunc(Number(monotonicNs() - this.startTimeNs) / (1e9 / this.sampleRate));
  }

  /** Number of frames behind until being in sync. */
  get framesBehind(): number {
    return this.expectedFrameCount - this.totalFrames;
  }

  /**
   * Return if an interval has completed.
   *
   * An interval has completed when sampleRate amount of frames has been sent since
   * previous interval start.
   */
  get intervalCompleted(): boolean {
    return this.intervalFrames >= this.sampleRate;
  }

  /** Add newly sent frames to statistics. */
  tick(sentFrames: number): void {
    this.totalFrames += sentFrames;
    this.intervalFrames += sentFrames;
  }

  /** Start measuring a new time interval. */
  newInterval(): [number, number] {
    const endTime = monotonic();
    const diff = endTime - this.intervalTime;
    this.intervalTime = endTime;

    const frames = this.intervalFrames;
    this.intervalFrames = 0;
    return [diff, frames];
  }
}

/** Simple client to stream audio. */
export class StreamClient {
  controlClient: ControlClient | null = null;
  timingServer: TimingServer | null = null;
  private readonly _packetBacklog = new PacketFifo<Buffer>(PACKET_BACKLOG_SIZE);
  private _encryptionTypes: EncryptionType = EncryptionType.Unknown;
  private _metadataTypes: MetadataType = MetadataType.NotSupported;
  private _metadata: MediaMetadata = emptyMetadata();
  private _listener: WeakRef<RaopListener> | null = null;
  private readonly _info: Record<string, unknown> = {};
  private _properties: Record<string, string> = {};
  private _isPlaying = false;

  constructor(
    readonly rtsp: RtspSession,
    readonly context: StreamContext,
    private readonly _protocol: StreamProtocol,
    readonly settings: Settings,
  ) {}

  /** Return current listener. */
  get listener(): RaopListener | null {
    return this._listener?.deref() ?? null;
  }

  /** Change current listener. */
  set listener(newListener: RaopListener | null) {
    this._listener = newListener ? new WeakRef(newListener) : null;
  }

  /** Return current playback information. */
  get playbackInfo(): PlaybackInfo {
    const metadata = metadataEquals(this._metadata, EMPTY_METADATA) ? MISSING_METADATA : this._metadata;
    return { metadata, position: this.context.position };
  }

  /** Return value mappings for server /info values. */
  get info(): Record<string, unknown> {
    return this._info;
  }

  /** Close session and free up resources. */
  close(): void {
    this._protocol.teardown();
    this.controlClient?.close();
    this.timingServer?.close();
  }

  /** Initialize the session. */
  async initialize(properties: Record<string, string>): Promise<void> {
    this._properties = properties;
    this._encryptionTypes = getEncryptionTypes(properties);
    this._metadataTypes = getMetadataTypes(properties);

    LOGGER.debug("Initializing RTSP with encryption=%s, metadata=%s", this._encryptionTypes, this._metadataTypes);

    // Misplaced check that unencrypted data is supported
    const intersection = this._encryptionTypes & SUPPORTED_ENCRYPTIONS;
    if (!intersection || intersection === EncryptionType.Unknown) {
      LOGGER.debug("No supported encryption type, continuing anyway");
    }

    this._updateOutputProperties(properties);

    const [, controlClient] = await createDatagramEndpoint(() => new ControlClient(this.context, this._packetBacklog), {
      localAddr: [this.rtsp.connection.localIp, this.settings.protocols.raop.control_port],
    });
    const [, timingServer] = await createDatagramEndpoint(() => new TimingServer(), {
      localAddr: [this.rtsp.connection.localIp, this.settings.protocols.raop.timing_port],
    });

    this.controlClient = controlClient;
    this.timingServer = timingServer;

    LOGGER.debug("Local ports: control=%d, timing=%d", this.controlClient.port, this.timingServer.port);

    Object.assign(this._info, await this.rtsp.info());
    LOGGER.debug("Updated info parameters to: %s", this.info);

    // Handle some special authentication cases
    if (this._requiresAuthSetup) await this.rtsp.authSetup();

    // Set up the streaming session
    await this._protocol.setup(this.timingServer.port, this.controlClient.port);
  }

  private _updateOutputProperties(properties: Record<string, string>): void {
    [this.context.sampleRate, this.context.channels, this.context.bytesPerChannel] = getAudioProperties(properties);
    LOGGER.debug(
      "Update play settings to %d/%d/%dbit",
      this.context.sampleRate,
      this.context.channels,
      this.context.bytesPerChannel * 8,
    );
  }

  private get _requiresAuthSetup(): boolean {
    // Do auth-setup if MFiSAP encryption is supported by receiver. Also, at least for
    // now, only do this for AirPort Express as some receivers won't play audio if
    // setup process isn't finished: https://github.com/postlund/pyatv/issues/1134
    const modelName = this._properties.am ?? "";
    return (this._encryptionTypes & EncryptionType.MFiSAP) !== 0 && modelName.startsWith("AirPort");
  }

  /** Stop what is currently playing. */
  stop(): void {
    LOGGER.debug("Stopping audio playback");
    this._isPlaying = false;
  }

  /** Change volume on the receiver. */
  async setVolume(volume: number): Promise<void> {
    await this.rtsp.setParameter("volume", String(volume));
    this.context.volume = volume;
  }

  /** Send an audio stream to the device. */
  async sendAudio(source: AudioSource, metadata: MediaMetadata = emptyMetadata(), volume: number | null = null): Promise<void> {
    if (this.controlClient === null || this.timingServer === null) throw new Error("not initialized");

    this.context.reset();

    let transport: DatagramTransport | null = null;
    try {
      // Create a socket used for writing audio packets (ugly)
      [transport] = await createDatagramEndpoint(() => new AudioProtocol(), {
        remoteAddr: [this.rtsp.connection.remoteIp, this.context.serverPort],
      });

      // Start sending sync packets
      this.controlClient.start(this.rtsp.connection.remoteIp);

      // Send progress if supported by receiver
      if (this._metadataTypes & MetadataType.Progress) {
        const start = this.context.rtptime;
        const now = this.context.rtptime;
        const end = start + source.duration * this.context.sampleRate;
        await this.rtsp.setParameter("progress", `${start}/${now}/${end}`);
      }

      // Apply text metadata if it is supported
      this._metadata = metadata;
      if (this._metadataTypes & MetadataType.Text) {
        LOGGER.debug("Playing with metadata: %s", this.playbackInfo.metadata);
        await this.rtsp.setMetadata(this.context.rtspSession, this.context.rtpseq, this.context.rtptime, this.playbackInfo.metadata);
      }

      // Send artwork if that is supported
      if (this._metadataTypes & MetadataType.Artwork && metadata.artwork !== null) {
        LOGGER.debug("Sending %s bytes artwork", metadata.artwork.length);
        await this.rtsp.setArtwork(this.context.rtspSession, this.context.rtpseq, this.context.rtptime, metadata.artwork);
      }

      // Start keep-alive task to ensure connection is not closed by remote device
      await this._protocol.startFeedback();

      this.listener?.playing(this.playbackInfo);

      // Start playback
      await this.rtsp.record();

      await this.rtsp.flush({
        headers: {
          Range: "npt=0-",
          Session: String(this.context.rtspSession),
          "RTP-Info": `seq=${this.context.rtpseq};rtptime=${this.context.rtptime}`,
        },
      });

      if (volume) await this.setVolume(pctToDbfs(volume));

      await this._streamData(source, transport);
    } catch (ex) {
      // Re-raise internal exceptions to maintain a proper stack trace
      if (ex instanceof ProtocolError || ex instanceof AuthenticationError) throw ex;
      throw new ProtocolError("an error occurred during streaming", { cause: ex });
    } finally {
      this._packetBacklog.clear(); // Don't keep old packets around (big!)
      if (transport) {
        // TODO: Teardown should not be done here. In fact, nothing should be closed
        // here since the connection should be reusable for streaming more audio files.
        // Refactor when support for that is added.
        await this.rtsp.teardown(this.context.rtspSession);
        transport.close();
      }
      this._protocol.teardown();
      this.close();

      this.listener?.stopped();
    }
  }

  private async _streamData(source: AudioSource, transport: DatagramTransport): Promise<void> {
    const stats = new Statistics(this.context.sampleRate);

    const initialTime = monotonic();
    this._isPlaying = true;
    let prevSlowSeqno: number | null = null;
    let numberSlowSeqno = 0;
    while (this._isPlaying) {
      const currentSeqno = this.context.rtpseq - 1;

      let numSent = await this._sendPacket(source, stats.totalFrames === 0, transport);
      if (numSent === 0) break;

      stats.tick(numSent);
      const framesBehind = stats.framesBehind;

      // If we are late, send some additional frames with hopes of catching up
      if (framesBehind >= FRAMES_PER_PACKET) {
        const maxPackets = Math.min(Math.trunc(framesBehind / FRAMES_PER_PACKET), MAX_PACKETS_COMPENSATE);
        LOGGER.debug("Compensating with %d packets (%d frames behind)", maxPackets, framesBehind);
        let hasMorePackets: boolean;
        [numSent, hasMorePackets] = await this._sendNumberOfPackets(source, transport, maxPackets);
        stats.tick(numSent);
        if (!hasMorePackets) break;
      }

      // Log how long it took to send sample_rate amount of frames (should be one
      // second).
      if (stats.intervalCompleted) {
        const [intervalTime, intervalFrames] = stats.newInterval();
        LOGGER.debug(
          "Sent %d frames in %fs (current frames: %d, expected: %d)",
          intervalFrames,
          intervalTime,
          stats.totalFrames,
          stats.expectedFrameCount,
        );
      }

      // Calculate the actual absolute position in stream and where we actually are
      // (from when we initially stared to stream). The diff is the time we need to
      // sleep until next lap.
      const absTimeStream = stats.totalFrames / this.context.sampleRate;
      const relToStart = monotonic() - initialTime;
      const diff = absTimeStream - relToStart;
      if (diff > 0) {
        numberSlowSeqno = 0;
        await sleep(diff);
      } else {
        // Increase number of consecutive frames that we are late
        if (prevSlowSeqno === currentSeqno - 1) numberSlowSeqno += 1;

        // Log warning if we reached threshold value
        const logMethod = numberSlowSeqno >= SLOW_WARNING_THRESHOLD ? LOGGER.warning : LOGGER.debug;
        logMethod.call(
          LOGGER,
          "Too slow to keep up for seqno %d (%f vs %f => %f)",
          currentSeqno,
          absTimeStream,
          relToStart,
          diff,
        );
        prevSlowSeqno = currentSeqno;
      }
    }

    LOGGER.debug("Audio finished sending in %fs", Number(monotonicNs() - stats.startTimeNs) / 1e9);
  }

  private async _sendPacket(source: AudioSource, firstPacket: boolean, transport: DatagramTransport): Promise<number> {
    // Once all frames in the audio stream have been sent, we are still "latency" behind
    // and will start sending padding (empty audio) until we catch up. This is needed to
    // keep the sync packets in line with real time.
    if (this.context.paddingSent >= this.context.latency) return 0;

    let frames = await source.readframes(FRAMES_PER_PACKET);
    if (frames.length === 0) {
      // No more frames to send means we send padding packets (just zeros) to keep sync
      // packets accurate
      frames = Buffer.alloc(this.context.packetSize);
      this.context.paddingSent += Math.trunc(frames.length / this.context.frameSize);
    } else if (frames.length !== this.context.packetSize) {
      // The audio stream length seldom aligns with number of frames per packet, so pad
      // the last packet with zeros
      frames = Buffer.concat([frames, Buffer.alloc(this.context.packetSize - frames.length)]);
    }

    const header = AudioPacketHeader.encode(
      0x80,
      firstPacket ? 0xe0 : 0x60,
      this.context.rtpseq,
      this.context.rtptime,
      this.rtsp.sessionId,
    );

    if (transport.isClosing()) {
      LOGGER.warning("Connection closed while streaming audio");
      return 0;
    }

    // Send packet and add it to backlog
    const [rtpseq, packet] = await this._protocol.sendAudioPacket(transport, header, frames);
    this._packetBacklog.set(rtpseq, packet);

    this.context.rtpseq = (this.context.rtpseq + 1) % 2 ** 16;
    this.context.headTs += Math.trunc(frames.length / this.context.frameSize);

    return Math.trunc(frames.length / this.context.frameSize);
  }

  /**
   * Send a specific number of packets.
   *
   * Return total number of sent frames and if more frames are available.
   */
  private async _sendNumberOfPackets(source: AudioSource, transport: DatagramTransport, count: number): Promise<[number, boolean]> {
    let totalFrames = 0;
    for (let i = 0; i < count; i++) {
      const sent = await this._sendPacket(source, false, transport);
      totalFrames += sent;
      if (sent === 0) return [totalFrames, false];
    }
    return [totalFrames, true];
  }
}
