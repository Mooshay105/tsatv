#!/usr/bin/env bun
/** Simple proxy server to intercept traffic. */

import { AbstractHAPChannel, setupChannel } from "../auth/hap_channel.ts";
import { parseCredentials, type PairVerifyProcedure } from "../auth/hap_pairing.ts";
import { HAPSession } from "../auth/hap_session.ts";
import { hkdfExpand, SRPAuthHandler } from "../auth/hap_srp.ts";
import { SERVER_IDENTIFIER } from "../auth/server_auth.ts";
import { Protocol } from "../const.ts";
import { MutableService } from "../core/index.ts";
import * as mdns from "../core/mdns.ts";
import {
  DATASTREAM_INPUT_INFO,
  DATASTREAM_OUTPUT_INFO,
  DATASTREAM_SALT,
  EVENTS_READ_INFO,
  EVENTS_SALT,
  EVENTS_WRITE_INFO,
} from "../protocols/airplay/ap2_session.ts";
import { extractCredentials, verifyConnection } from "../protocols/airplay/auth/index.ts";
import { BaseDataStreamChannel, BaseEventChannel, type DataStreamMessage } from "../protocols/airplay/channels.ts";
import { BaseAirPlayServerAuth } from "../protocols/airplay/server_auth.ts";
import { decodePlistBody, encodePlistBody, logRequest, logResponse } from "../protocols/airplay/utils.ts";
import { AUTH_TAG_LENGTH, CompanionConnection, type CompanionConnectionListener, FrameType } from "../protocols/companion/connection.ts";
import { CompanionProtocol, MessageType } from "../protocols/companion/protocol.ts";
import { CompanionServerAuth } from "../protocols/companion/server_auth.ts";
import { MrpConnection } from "../protocols/mrp/connection.ts";
import * as pb from "../protocols/mrp/protobuf/index.ts";
import { MrpProtocol } from "../protocols/mrp/protocol.ts";
import { MrpServerAuth } from "../protocols/mrp/server_auth.ts";
import { InfoSettings } from "../settings.ts";
import { Event, type Task, createTask } from "../support/asyncio.ts";
import { BytesReader } from "../support/bytes.ts";
import * as chacha20 from "../support/chacha20.ts";
import { formatTxtDict, parseTxtDict } from "../support/dns.ts";
import { BasicHttpServer, type HandlerResult, HttpConnection, HttpRequest, HttpResponse, httpConnect } from "../support/http.ts";
import { logBinary, logProtobuf, shiftHexIdentifier } from "../support/index.ts";
import { DEBUG, getLogger } from "../support/logging.ts";
import * as net from "../support/net.ts";
import * as opack from "../support/opack.ts";
import { createConnection, createServer, type Protocol as TransportProtocol, type Server, type Transport } from "../support/transport.ts";
import { readVariant, writeVariant } from "../support/variant.ts";
import { Zeroconf } from "../support/zeroconf.ts";
import { ArgumentParser, SystemExit, type Namespace } from "./argparse.ts";
import { basicConfig, logCurrentVersion } from "./index.ts";
import { getIO, print } from "./io.ts";

const LOGGER = getLogger("pyatv.scripts.atvproxy");

const DEVICE_NAME = "Proxy";
const BLUETOOTH_ADDRESS = "DA:97:7C:BA:A3:7A";
const AIRPLAY_IDENTIFIER = "4D797FD3-3538-427E-A47B-A32FC6CF3A6A";

const PROPERTY_CASE_MAP: Record<string, string> = {
  rpad: "rpAD",
  rpba: "rpBA",
  rpfl: "rpFl",
  rpha: "rpHA",
  rphi: "rpHI",
  rphn: "rpHN",
  rpmac: "rpMac",
  rpmd: "rpMd",
  rpmrtid: "rpMRtID",
  rpvr: "rpVr",
};

const COMPANION_AUTH_FRAMES = [FrameType.PS_Start, FrameType.PS_Next, FrameType.PV_Start, FrameType.PV_Next];
const COMPANION_OPACK_FRAMES = [FrameType.U_OPACK, FrameType.E_OPACK, FrameType.P_OPACK];

const headersWithoutContentLength = (headers: Iterable<[string, string]>): Record<string, string> =>
  Object.fromEntries([...headers].filter(([k]) => k.toLowerCase() !== "content-length"));

const replaceRequest = (request: HttpRequest, changes: Partial<Pick<HttpRequest, "path" | "body">> & { headers?: Record<string, string> }) =>
  new HttpRequest(
    request.method,
    changes.path ?? request.path,
    request.protocol,
    request.version,
    changes.headers ?? request.headers,
    changes.body ?? request.body,
  );

const replaceResponse = (response: HttpResponse, changes: { headers?: Record<string, string>; body?: Buffer }) =>
  new HttpResponse(
    response.protocol,
    response.version,
    response.code,
    response.message,
    changes.headers ?? response.headers,
    changes.body ?? response.body,
  );

// --- MRP -----------------------------------------------------------------------------

/** Implementation of a fake MRP Apple TV. */
export class MrpAppleTVProxy extends MrpServerAuth implements TransportProtocol {
  private buffer: Buffer = Buffer.alloc(0);
  transport: Transport | null = null;
  private chacha: chacha20.Chacha20Cipher | null = null;
  readonly connection: MrpConnection;
  readonly protocol: MrpProtocol;

  constructor(address: string, port: number, credentials: string) {
    super(DEVICE_NAME);
    this.connection = new MrpConnection(address, port);
    this.protocol = new MrpProtocol(
      this.connection,
      new SRPAuthHandler(),
      new MutableService(null, Protocol.MRP, port, {}, credentials),
      new InfoSettings(),
    );
  }

  /** Start the proxy instance. */
  async start(): Promise<void> {
    await this.protocol.start(true);
    this.connection.listener = this;
    this.processBuffer();
  }

  /** Stop the proxy instance. */
  stop(): void {
    this.transport?.close();
    this.transport = null;
    this.protocol.stop();
  }

  connectionMade(transport: Transport): void {
    this.transport = transport;
  }

  connectionLost(exc: Error | null): void {
    LOGGER.debug("Connection lost to client device: %s", exc);
    this.stop();
  }

  enableEncryption(outputKey: Uint8Array, inputKey: Uint8Array): void {
    this.chacha = new chacha20.Chacha20Cipher(outputKey, inputKey);
  }

  /** Send protobuf message to client. */
  sendToClient(message: pb.ProtocolMessage): void {
    let data = message.serializeToString();
    LOGGER.info("<<(DECRYPTED): %s", message);
    if (this.chacha) {
      data = this.chacha.encrypt(data);
      logBinary(LOGGER, "<<(ENCRYPTED)", { Message: data });
    }
    this.transport?.write(Buffer.concat([writeVariant(data.length), data]));
  }

  /** Send raw data to client. */
  sendRaw(raw: Buffer): void {
    const parsed = pb.ProtocolMessage.decode(raw);
    logBinary(LOGGER, "ATV->APP", { Raw: raw });
    LOGGER.info("ATV->APP Parsed: %s", parsed);
    let data = raw;
    if (this.chacha) {
      data = this.chacha.encrypt(raw);
      logBinary(LOGGER, "ATV->APP", { Encrypted: data });
    }
    try {
      this.transport?.write(Buffer.concat([writeVariant(data.length), data]));
    } catch (ex) {
      LOGGER.exception("Failed to send to app: %s", ex);
    }
  }

  /** Message received from ATV. */
  messageReceived(_message: pb.ProtocolMessage, raw: Buffer): void {
    this.sendRaw(raw);
  }

  /** Message received from iOS app/client. */
  dataReceived(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    if (this.connection.connected) this.processBuffer();
  }

  private processBuffer(): void {
    while (this.buffer.length > 0) {
      const [length, raw] = readVariant(this.buffer);
      if (raw.length < length) break;

      let data = raw.subarray(0, length);
      this.buffer = raw.subarray(length);
      if (this.chacha) {
        logBinary(LOGGER, "ENC Phone->ATV", { Encrypted: data });
        data = this.chacha.decrypt(data);
      }

      const message = pb.ProtocolMessage.decode(data);
      LOGGER.info("(DEC Phone->ATV): %s", message);

      try {
        if (message.type === pb.DEVICE_INFO_MESSAGE) this.handleDeviceInfo(message, pb.extractInner(message));
        else if (message.type === pb.CRYPTO_PAIRING_MESSAGE) this.handleCryptoPairing(message, pb.extractInner(message));
        else this.connection.sendRaw(data);
      } catch (ex) {
        LOGGER.exception("Error while dispatching message: %s", ex);
      }
    }
  }
}

// --- Companion -----------------------------------------------------------------------

/** Implementation of a fake Companion device. */
export class CompanionAppleTVProxy extends CompanionServerAuth implements CompanionConnectionListener, TransportProtocol {
  private buffer: Buffer = Buffer.alloc(0);
  transport: Transport | null = null;
  private chacha: chacha20.Chacha20Cipher | null = null;
  readonly connection: CompanionConnection;
  readonly protocol: CompanionProtocol;
  private systemInfoXid: unknown = null;
  private readonly receiveEvent = new Event();
  private receiveTask: Task<void> | null = null;

  constructor(
    address: string,
    port: number,
    readonly credentials: string,
  ) {
    super(DEVICE_NAME);
    this.connection = new CompanionConnection(address, port);
    this.protocol = new CompanionProtocol(
      this.connection,
      new SRPAuthHandler(),
      new MutableService(null, Protocol.Companion, port, {}, credentials),
    );
    // CompanionProtocol sets listener, override it now
    this.connection.setListener(this);
  }

  /** Start the proxy instance. */
  async start(): Promise<void> {
    await this.protocol.start();
    this.receiveTask = createTask((signal) => this.processTask(signal));
    this.receiveEvent.set();
  }

  enableEncryption(outputKey: Uint8Array, inputKey: Uint8Array): void {
    this.chacha = new chacha20.Chacha20Cipher(outputKey, inputKey, 12);
  }

  private async processTask(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      LOGGER.debug("Waiting for data from client");
      try {
        await this.receiveEvent.wait();
        if (signal.aborted) break;
        await this.processBuffer();
      } catch (ex) {
        LOGGER.exception("error processing incoming messages: %s", ex);
      }
    }
  }

  private async processBuffer(): Promise<void> {
    LOGGER.debug("Process buffer (size: %d)", this.buffer.length);

    const payloadLength = this.buffer.length >= 4 ? 4 + this.buffer.readUIntBE(1, 3) : Number.POSITIVE_INFINITY;
    if (this.buffer.length < payloadLength) {
      LOGGER.debug("Expected %d bytes, have %d (waiting for more)", payloadLength, this.buffer.length);
      this.receiveEvent.clear();
      return;
    }

    const frameType = this.buffer[0] as FrameType;
    const data = this.buffer.subarray(4, payloadLength);
    this.buffer = this.buffer.subarray(payloadLength);

    if (COMPANION_AUTH_FRAMES.includes(frameType)) {
      try {
        this.handleAuthFrame(frameType, opack.unpack(data)[0]);
      } catch (ex) {
        LOGGER.exception("failed to handle auth frame: %s", ex);
      }
    } else {
      try {
        this.sendBytesToAtv(frameType, data);
      } catch (ex) {
        LOGGER.exception("data exchange failed: %s", ex);
      }
    }
  }

  connectionMade(transport: Transport): void {
    LOGGER.debug("Client connected to Companion proxy");
    this.transport = transport;
  }

  connectionLost(exc: Error | null): void {
    LOGGER.debug("Connection lost to client device: %s", exc);
    if (this.connection.connected) this.connection.close();
    this.receiveTask?.cancel();
    this.receiveEvent.set();
  }

  dataReceived(data: Buffer): void {
    logBinary(LOGGER, "Data from client", { Data: data });
    this.buffer = Buffer.concat([this.buffer, data]);
    if (this.connection.connected) this.receiveEvent.set();
  }

  /** Send encoded data to remote device (ATV). */
  sendBytesToAtv(frameType: FrameType, data: Buffer): void {
    logBinary(LOGGER, `>>(ENCRYPTED) FrameType=${FrameType[frameType]}`, { Message: data });

    if (this.chacha && data.length > 0) {
      const header = Buffer.alloc(4);
      header[0] = frameType;
      header.writeUIntBE(data.length, 1, 3);
      data = this.chacha.decrypt(data, null, header);
      logBinary(LOGGER, "<<(DECRYPTED)", { Message: data });
    }

    if (frameType !== FrameType.E_OPACK) {
      this.connection.send(frameType, data);
      return;
    }

    const unpacked = opack.unpack(data)[0] as Record<string, any>;
    this.processOutgoingData(frameType, unpacked);
    this.protocol.sendOpack(frameType, unpacked);
  }

  /** Frame was received from remote device. */
  frameReceived(frameType: FrameType, data: Buffer): void {
    if (COMPANION_AUTH_FRAMES.includes(frameType)) {
      // Do not override authentication
      this.protocol.frameReceived(frameType, data);
      return;
    }

    LOGGER.debug("Received frame %s: %s", FrameType[frameType], data);
    if (COMPANION_OPACK_FRAMES.includes(frameType)) {
      const [opackData] = opack.unpack(data);
      LOGGER.debug("Received OPACK: %s", opackData);
      this.sendToClient(frameType, opackData);
    } else {
      this.sendBytesToClient(frameType, data);
    }
  }

  /** Send encoded data to client device (iOS). */
  sendBytesToClient(frameType: FrameType, data: Buffer): void {
    if (!this.transport) {
      LOGGER.error("Tried to send to client, but not connected");
      return;
    }

    let payloadLength = data.length;
    if (this.chacha && payloadLength > 0) payloadLength += AUTH_TAG_LENGTH;
    const header = Buffer.alloc(4);
    header[0] = frameType;
    header.writeUIntBE(payloadLength, 1, 3);

    if (this.chacha && data.length > 0) {
      data = this.chacha.encrypt(data, null, header);
      logBinary(LOGGER, ">> Send", { Header: header, Encrypted: data });
    }

    this.transport.write(Buffer.concat([header, data]));
  }

  /** Send data to client device (iOS). */
  sendToClient(frameType: FrameType, data: Record<string, unknown>): void {
    this.processIncomingData(frameType, data as Record<string, any>);
    this.sendBytesToClient(frameType, opack.pack(data));
  }

  /** Apply any required modifications to outgoing data. */
  processOutgoingData(frameType: FrameType, data: Record<string, any>): void {
    if (frameType !== FrameType.E_OPACK) return;

    if (data._i === "_systemInfo") {
      this.systemInfoXid = data._x;
      const creds = parseCredentials(this.credentials);
      const payload = data._c;
      // The server will drop older connections with the same identifier, so mangle
      // them here to prevent disconnects if the client device is also directly
      // connected to the server. NB: Only fields present are changed (pyatv assumes
      // that they are always present).
      if (payload._i) payload._i = shiftHexIdentifier(payload._i);
      payload._idsID = creds.clientId.toString("utf-8").toUpperCase();
      if (payload._pubID) payload._pubID = shiftHexIdentifier(payload._pubID);
      const siriInfo = payload._siriInfo;
      if (siriInfo) {
        if (siriInfo.peerData?.sharedUserIdentifier) {
          siriInfo.peerData.sharedUserIdentifier = shiftHexIdentifier(siriInfo.peerData.sharedUserIdentifier);
        }
        const audioSystemInfo = siriInfo["audio-session-coordination.system-info"];
        if (audioSystemInfo?.mediaRemoteGroupIdentifier) {
          audioSystemInfo.mediaRemoteGroupIdentifier = shiftHexIdentifier(audioSystemInfo.mediaRemoteGroupIdentifier);
        }
      }
    }
  }

  /** Apply any required modifications to incoming data. */
  processIncomingData(frameType: FrameType, data: Record<string, any>): void {
    if (frameType !== FrameType.E_OPACK) return;

    if (data._t === MessageType.Response && data._x === this.systemInfoXid) {
      this.systemInfoXid = null;
      const payload = data._c;
      payload.name = DEVICE_NAME;
      if (payload._i) payload._i = shiftHexIdentifier(payload._i);
      if (payload._idsID) payload._idsID = shiftHexIdentifier(payload._idsID);
      payload._pubID = BLUETOOTH_ADDRESS;
      if ("_mrID" in payload) payload._mrID = SERVER_IDENTIFIER;
      if ("_mRtID" in payload) payload._mRtID = SERVER_IDENTIFIER;
      const siriInfo = payload._siriInfo;
      if (siriInfo) {
        if (siriInfo.peerData) {
          siriInfo.peerData.userAssignedDeviceName = DEVICE_NAME;
          if (siriInfo.peerData.homeAccessoryInfo) siriInfo.peerData.homeAccessoryInfo.name = DEVICE_NAME;
        }
        const audioSystemInfo = siriInfo["audio-session-coordination.system-info"];
        if (audioSystemInfo) {
          if (audioSystemInfo.mediaRemoteGroupIdentifier) {
            audioSystemInfo.mediaRemoteGroupIdentifier = shiftHexIdentifier(audioSystemInfo.mediaRemoteGroupIdentifier);
          }
          if ("mediaRemoteRouteIdentifier" in audioSystemInfo) audioSystemInfo.mediaRemoteRouteIdentifier = SERVER_IDENTIFIER;
        }
      }
    }
  }
}

// --- AirPlay channels ----------------------------------------------------------------

/** Base class for AirPlay channel connection proxies. */
abstract class AirPlayChannelAppleTVProxy extends AbstractHAPChannel {
  remoteTransport: Transport | null = null;
  remoteProtocol: AbstractHAPChannel | null = null;
  localBuffer: Buffer = Buffer.alloc(0);
  remoteBuffer: Buffer = Buffer.alloc(0);
  private readonly connectedEvent = new Event();

  constructor(
    readonly name: string,
    readonly verifier: PairVerifyProcedure,
    readonly remoteAddress: string,
    readonly remotePort: number,
    readonly remoteSalt: string,
    readonly remoteOutputInfo: string,
    readonly remoteInputInfo: string,
    outputKey: Uint8Array,
    inputKey: Uint8Array,
  ) {
    super(outputKey, inputKey);
  }

  override connectionMade(transport: Transport): void {
    super.connectionMade(transport);
    this.connectToRemote().then(
      () => this.handleReceived(),
      (ex) => LOGGER.exception("%s failed to connect to remote: %s", this.name, ex),
    );
  }

  override connectionLost(exc: Error | null): void {
    super.connectionLost(exc);
    this.remoteTransport?.close();
    this.remoteTransport = null;
    this.remoteProtocol = null;
  }

  override close(): void {
    this.remoteTransport?.close();
    this.remoteTransport = null;
    this.remoteProtocol = null;
    super.close();
  }

  /** Handle received data that was put in buffer. */
  handleReceived(): void {
    if (!this.connectedEvent.isSet()) return;

    if (this.buffer.length > 0) {
      LOGGER.debug("%s received from Client: %s", this.name, this.buffer);
      this.localBuffer = Buffer.concat([this.localBuffer, this.buffer]);
      this.buffer = Buffer.alloc(0);
    }

    while (this.localBuffer.length > 0) {
      const [toRemote, rest] = this.processBuffer(this.localBuffer);
      this.localBuffer = rest;
      if (toRemote.length === 0) break;
      this.remoteSend(toRemote);
    }
  }

  /** Message was received from remote side of channel. */
  remoteReceived(data: Buffer): void {
    LOGGER.debug("%s received from Apple TV: %s", this.name, data);
    this.remoteBuffer = Buffer.concat([this.remoteBuffer, data]);

    while (this.remoteBuffer.length > 0) {
      const [toClient, rest] = this.processRemoteBuffer(this.remoteBuffer);
      this.remoteBuffer = rest;
      if (toClient.length === 0) break;
      this.send(toClient);
    }
  }

  /** Send message to remote side of channel. */
  remoteSend(data: Buffer): void {
    if (!this.remoteProtocol) throw new Error("not connected to remote");
    this.remoteProtocol.send(data);
  }

  /** Process data from client before proxying. */
  processBuffer(data: Buffer): [Buffer, Buffer] {
    return [data, Buffer.alloc(0)];
  }

  /** Process data from remote before proxying. */
  processRemoteBuffer(data: Buffer): [Buffer, Buffer] {
    return [data, Buffer.alloc(0)];
  }

  private async connectToRemote(): Promise<void> {
    [this.remoteTransport, this.remoteProtocol] = await setupChannel(
      (outputKey, inputKey) => new AirPlayChannelAppleTVForwarder(this, outputKey, inputKey),
      this.verifier,
      this.remoteAddress,
      this.remotePort,
      this.remoteSalt,
      this.remoteOutputInfo,
      this.remoteInputInfo,
    );
    this.connectedEvent.set();
  }
}

/** Outgoing AirPlay channel connection. */
class AirPlayChannelAppleTVForwarder extends AbstractHAPChannel {
  constructor(
    readonly channelProxy: AirPlayChannelAppleTVProxy,
    outputKey: Uint8Array,
    inputKey: Uint8Array,
  ) {
    super(outputKey, inputKey);
  }

  override connectionLost(exc: Error | null): void {
    super.connectionLost(exc);
    this.channelProxy.close();
  }

  handleReceived(): void {
    this.channelProxy.remoteReceived(this.buffer);
    this.buffer = Buffer.alloc(0);
  }
}

/** AirPlay event channel connection proxy. */
class AirPlayEventChannelAppleTVProxy extends AirPlayChannelAppleTVProxy {
  constructor(
    verifier: PairVerifyProcedure,
    remoteAddress: string,
    remotePort: number,
    sharedKey: Uint8Array,
    readonly rewriteInfo: (info: Record<string, any>) => Record<string, any>,
  ) {
    super(
      "Event channel",
      verifier,
      remoteAddress,
      remotePort,
      EVENTS_SALT,
      EVENTS_READ_INFO,
      EVENTS_WRITE_INFO,
      hkdfExpand(EVENTS_SALT, EVENTS_WRITE_INFO, sharedKey),
      hkdfExpand(EVENTS_SALT, EVENTS_READ_INFO, sharedKey),
    );
  }

  override processBuffer(data: Buffer): [Buffer, Buffer] {
    const [response, consumed, rest] = BaseEventChannel.parseResponse(data);
    if (response) logResponse(LOGGER, response, `${this.name} `);
    return [consumed, rest];
  }

  override processRemoteBuffer(data: Buffer): [Buffer, Buffer] {
    const [request, consumed, rest] = BaseEventChannel.parseRequest(data);
    if (request) {
      logRequest(LOGGER, request, `${this.name} `);
      const decodedData = decodePlistBody(request.body as Buffer) ?? {};
      if (request.path === "/command" && decodedData.type === "updateInfo") {
        const updated = replaceRequest(request, {
          headers: headersWithoutContentLength(request.headers.entries()),
          body: encodePlistBody({ ...decodedData, value: this.rewriteInfo(decodedData.value) }),
        });
        return [BaseEventChannel.formatRequest(updated), rest];
      }
    }
    return [consumed, rest];
  }
}

class SendMessageVerbatim extends Error {}
class IgnoreMessage extends Error {}

/** AirPlay data stream channel connection proxy. */
class AirPlayDataStreamChannelAppleTVProxy extends AirPlayChannelAppleTVProxy {
  constructor(
    streamId: number,
    verifier: PairVerifyProcedure,
    remoteAddress: string,
    remotePort: number,
    sharedKey: Uint8Array,
    seed: bigint | number,
    readonly targetIdentifier: string,
    readonly targetGroup: string,
  ) {
    const salt = DATASTREAM_SALT + String(BigInt(seed) & 0xffffffffffffffffn);
    super(
      `Data stream ${streamId} channel`,
      verifier,
      remoteAddress,
      remotePort,
      salt,
      DATASTREAM_OUTPUT_INFO,
      DATASTREAM_INPUT_INFO,
      hkdfExpand(salt, DATASTREAM_INPUT_INFO, sharedKey),
      hkdfExpand(salt, DATASTREAM_OUTPUT_INFO, sharedKey),
    );
  }

  private encodeReply(seqno: bigint): Buffer {
    return BaseDataStreamChannel.encodeMessage({
      messageType: Buffer.concat([Buffer.from("rply"), Buffer.alloc(8)]),
      command: Buffer.alloc(4),
      seqno,
      padding: 0,
      payload: Buffer.alloc(0),
    });
  }

  override processBuffer(data: Buffer): [Buffer, Buffer] {
    const [message, consumed, rest] = BaseDataStreamChannel.decodeMessage(data);
    if (message) {
      this.logMessage(message, "client");
      try {
        return [BaseDataStreamChannel.encodeMessage(this.rewriteMessage(message, (m) => this.rewriteClientProtobuf(m))), rest];
      } catch (ex) {
        if (ex instanceof IgnoreMessage) {
          // Mechanism to ignore certain messages from the client
          if (message.messageType.toString("latin1").startsWith("sync")) this.send(this.encodeReply(message.seqno));
          return [Buffer.alloc(0), rest];
        }
        if (!(ex instanceof SendMessageVerbatim)) throw ex;
      }
    }
    return [consumed, rest];
  }

  override processRemoteBuffer(data: Buffer): [Buffer, Buffer] {
    const [message, consumed, rest] = BaseDataStreamChannel.decodeMessage(data);
    if (message) {
      this.logMessage(message, "remote");
      try {
        return [BaseDataStreamChannel.encodeMessage(this.rewriteMessage(message, (m) => this.rewriteRemoteProtobuf(m))), rest];
      } catch (ex) {
        if (!(ex instanceof SendMessageVerbatim)) throw ex;
      }
    }
    return [consumed, rest];
  }

  private rewriteMessage(
    message: DataStreamMessage,
    protobufRewriter: (message: pb.ProtocolMessage) => pb.ProtocolMessage | null,
  ): DataStreamMessage {
    if (!message.messageType.toString("latin1").startsWith("sync") || message.payload.length === 0) {
      throw new SendMessageVerbatim();
    }

    const payload = BaseDataStreamChannel.decodePayload(message.payload);
    const protobufs = payload?.params?.data ?? Buffer.alloc(0);

    const processed: pb.ProtocolMessage[] = [];
    let modified = false;
    for (const pbMessage of BaseDataStreamChannel.decodeProtobufs(protobufs)) {
      const modifiedMessage = protobufRewriter(pbMessage);
      if (modifiedMessage) modified = true;
      processed.push(modifiedMessage ?? pbMessage);
    }

    if (!modified) throw new SendMessageVerbatim();

    return {
      ...message,
      payload: BaseDataStreamChannel.encodePayload({
        ...payload,
        params: { ...payload.params, data: BaseDataStreamChannel.encodeProtobufs(processed) },
      }),
    };
  }

  private rewriteClientProtobuf(message: pb.ProtocolMessage): pb.ProtocolMessage | null {
    if (message.type === pb.DEVICE_INFO_MESSAGE) {
      const inner = pb.extractInner(message) as pb.DeviceInfoMessage;
      inner.uniqueIdentifier = shiftHexIdentifier(inner.uniqueIdentifier);
      for (const field of ["deviceUID", "managedConfigDeviceID", "groupUID", "senderDefaultGroupUID", "routingContextID", "airPlayGroupID"]) {
        if ((inner as any)[field]) (inner as any)[field] = shiftHexIdentifier((inner as any)[field]);
      }
      return message;
    }

    if (message.type === pb.SET_VOLUME_MESSAGE) {
      const svm = pb.extractInner(message) as pb.SetVolumeMessage;
      if (svm.outputDeviceUID === SERVER_IDENTIFIER) {
        svm.outputDeviceUID = this.targetIdentifier;
        return message;
      }
    }

    if (message.type === pb.CONFIGURE_CONNECTION_MESSAGE) {
      // iOS doesn't like the rewritten airplay group id and sends this message, but
      // sending it on causes issues with the connection.
      const ccm = pb.extractInner(message) as pb.ConfigureConnectionMessage;
      if (ccm.groupID) throw new IgnoreMessage();
    }

    return null;
  }

  private rewriteRemoteProtobuf(message: pb.ProtocolMessage): pb.ProtocolMessage | null {
    const shiftIfTarget = (obj: any, field: string) => {
      if (obj[field] && obj[field] === this.targetGroup) obj[field] = shiftHexIdentifier(obj[field]);
    };

    if (message.type === pb.DEVICE_INFO_MESSAGE || message.type === pb.DEVICE_INFO_UPDATE_MESSAGE) {
      const inner = pb.extractInner(message) as pb.DeviceInfoMessage;
      inner.uniqueIdentifier = SERVER_IDENTIFIER;
      inner.name = DEVICE_NAME;
      if (inner.deviceUID) inner.deviceUID = SERVER_IDENTIFIER;
      if (inner.managedConfigDeviceID) inner.managedConfigDeviceID = shiftHexIdentifier(inner.managedConfigDeviceID);
      shiftIfTarget(inner, "groupUID");
      if (inner.senderDefaultGroupUID) inner.senderDefaultGroupUID = shiftHexIdentifier(inner.senderDefaultGroupUID);
      if (inner.routingContextID) inner.routingContextID = shiftHexIdentifier(inner.routingContextID);
      shiftIfTarget(inner, "airPlayGroupID");
      for (const device of inner.groupedDevices as Iterable<any>) {
        if (device.deviceUID === this.targetIdentifier) {
          device.deviceUID = SERVER_IDENTIFIER;
          device.name = DEVICE_NAME;
        }
        shiftIfTarget(device, "groupUID");
        shiftIfTarget(device, "airPlayGroupID");
      }
      return message;
    }

    if (message.type === pb.UPDATE_OUTPUT_DEVICE_MESSAGE) {
      const uodm = pb.extractInner(message) as pb.UpdateOutputDeviceMessage;
      for (const outputDevice of [...uodm.outputDevices, ...uodm.clusterAwareOutputDevices] as any[]) {
        if (outputDevice.uniqueIdentifier === this.targetIdentifier) {
          outputDevice.uniqueIdentifier = SERVER_IDENTIFIER;
          outputDevice.name = DEVICE_NAME;
          if (outputDevice.bluetoothID && outputDevice.bluetoothID !== "00:00:00:00:00:00") outputDevice.bluetoothID = BLUETOOTH_ADDRESS;
          if (outputDevice.primaryUID) outputDevice.primaryUID = SERVER_IDENTIFIER;
          if (outputDevice.hasField("sourceInfo") && outputDevice.sourceInfo.routingContextUID) {
            outputDevice.sourceInfo.routingContextUID = shiftHexIdentifier(outputDevice.sourceInfo.routingContextUID);
          }
        }
        shiftIfTarget(outputDevice, "groupID");
        shiftIfTarget(outputDevice, "parentGroupIdentifier");
        shiftIfTarget(outputDevice, "airPlayGroupID");
      }
      return message;
    }

    if (message.type === pb.VOLUME_CONTROL_CAPABILITIES_DID_CHANGE_MESSAGE || message.type === pb.VOLUME_DID_CHANGE_MESSAGE) {
      const inner = pb.extractInner(message) as any;
      if (inner.outputDeviceUID && inner.outputDeviceUID === this.targetIdentifier) inner.outputDeviceUID = SERVER_IDENTIFIER;
      shiftIfTarget(inner, "endpointUID");
      return message;
    }

    return null;
  }

  private logMessage(message: DataStreamMessage, source: string): void {
    LOGGER.debug(
      "%s %s message: type=%s, command=%s, seqno=%s, padding=%s, payload=%s",
      this.name,
      source,
      message.messageType,
      message.command,
      message.seqno,
      message.padding,
      message.payload,
    );

    if (message.payload.length === 0) return;

    const data = BaseDataStreamChannel.decodePayload(message.payload);
    LOGGER.debug("%s %s message plist content: %s", this.name, source, data);

    const protobufs = data?.params?.data;
    if (!protobufs) return;

    for (const protobufMessage of BaseDataStreamChannel.decodeProtobufs(protobufs)) {
      logProtobuf(LOGGER, `${this.name} ${source} protobuf`, protobufMessage);
    }
  }
}

// --- AirPlay -------------------------------------------------------------------------

/** HTTP server used by the AirPlay proxy (hooks in encryption). */
export class AirPlayProxyHttpServer extends BasicHttpServer {
  constructor(readonly proxy: AirPlayAppleTVProxy) {
    super(proxy);
  }

  override connectionMade(transport: Transport): void {
    super.connectionMade(transport);
    this.proxy.connectionMade(transport);
  }

  override connectionLost(exc: Error | null): void {
    super.connectionLost(exc);
    this.proxy.connectionLost(exc);
  }

  override processReceived(data: Buffer): Buffer {
    return this.proxy.processReceived(data);
  }

  override processSent(data: Buffer): Buffer {
    return this.proxy.processSent(data);
  }
}

/** Implementation of a fake AirPlay device. */
export class AirPlayAppleTVProxy extends BaseAirPlayServerAuth {
  readonly targetIdentifier: string;
  readonly targetGroup: string;
  clientHapSession: HAPSession | null = null;
  clientEncryption = false;
  readonly service: MutableService;
  connection: HttpConnection | null = null;
  verifier: PairVerifyProcedure | null = null;
  transport: Transport | null = null;
  private readonly channelServers = new Map<string, Server>();
  private readonly connectedEvent = new Event();

  constructor(
    readonly address: string,
    readonly port: number,
    properties: Record<string, string>,
    readonly credentials: string | null,
  ) {
    super(DEVICE_NAME);
    this.targetIdentifier = properties.psi ?? "";
    this.targetGroup = properties.gid ?? "";
    this.service = new MutableService(null, Protocol.AirPlay, port, properties, credentials);
    // Routes that need special handling when proxied
    this.addRoute("GET", "/info", (r) => this.handleInfo(r));
    this.addRoute("SETUP", ".*", (r) => this.handleSetup(r));
    this.addRoute("TEARDOWN", ".*", (r) => this.handleTeardown(r));
  }

  /** Return IP address and port of client. */
  get clientAddress(): [string, number] {
    return this.transport!.getExtraInfo("peername");
  }

  /** Start the proxy instance. */
  async start(): Promise<void> {
    this.connection = await httpConnect(this.address, this.port);
    this.verifier = await verifyConnection(extractCredentials(this.service), this.connection);
    this.connectedEvent.set();
  }

  enableEncryption(outputKey: Uint8Array, inputKey: Uint8Array): void {
    const session = new HAPSession();
    session.enable(outputKey, inputKey);
    this.clientHapSession = session;
  }

  connectionMade(transport: Transport): void {
    LOGGER.debug("Client connected to AirPlay proxy");
    this.transport = transport;
  }

  connectionLost(exc: Error | null): void {
    LOGGER.debug("Connection lost to client device: %s", exc);
    this.connection?.close();
    for (const channelServer of this.channelServers.values()) channelServer.close();
  }

  /** Process incoming data. */
  processReceived(data: Buffer): Buffer {
    if (this.clientHapSession) {
      // Start encrypting from an incoming request
      this.clientEncryption = true;
      data = this.clientHapSession.decrypt(data);
      LOGGER.debug("Received (decrypted): %s", data);
    }
    return data;
  }

  /** Process outgoing data. */
  processSent(data: Buffer): Buffer {
    if (this.clientEncryption) {
      data = this.clientHapSession!.encrypt(data);
      logBinary(LOGGER, ">> Send", { Encrypted: data });
    }
    return data;
  }

  private handleInfo(request: HttpRequest): Promise<HttpResponse> {
    return (async () => {
      const response = await this.sendToAtv(request);
      const responseData = decodePlistBody(response.body as Buffer) ?? {};
      return replaceResponse(response, { body: encodePlistBody(this.rewriteInfo(responseData)) });
    })();
  }

  rewriteInfo(info: Record<string, any>): Record<string, any> {
    const output = { ...info };
    if ("psi" in info) output.psi = SERVER_IDENTIFIER;
    if ("name" in info) output.name = DEVICE_NAME;
    if ("senderAddress" in info) output.senderAddress = this.clientAddress.join(":");
    if ("deviceID" in info) output.deviceID = shiftHexIdentifier(info.deviceID);
    if ("pi" in info) output.pi = shiftHexIdentifier(output.pi);
    if ("txtAirPlay" in info) {
      const dnsTxt = Buffer.from(info.txtAirPlay);
      const parsed = parseTxtDict(new BytesReader(dnsTxt), dnsTxt.length);
      const dnsData: Record<string, string> = {};
      for (const [k, v] of parsed) dnsData[k] = typeof v === "string" ? v : Buffer.from(v).toString("utf-8");
      output.txtAirPlay = formatTxtDict(AirPlayAppleTVProxy.rewriteDnsTxt(dnsData));
    }
    if ("pk" in info) output.pk = BaseAirPlayServerAuth.keys.authPub;
    if ("macAddress" in info) output.macAddress = shiftHexIdentifier(info.macAddress);
    return output;
  }

  static rewriteDnsTxt(info: Record<string, string>): Record<string, string> {
    const output = { ...info };
    if ("btaddr" in info && info.btaddr !== "00:00:00:00:00:00") output.btaddr = BLUETOOTH_ADDRESS;
    if ("deviceid" in info) output.deviceid = shiftHexIdentifier(info.deviceid!);
    if ("pi" in info) output.pi = shiftHexIdentifier(output.pi!);
    if ("psi" in info) output.psi = SERVER_IDENTIFIER;
    if ("pk" in info) output.pk = BaseAirPlayServerAuth.keys.authPub.toString("hex");
    if ("gid" in info) output.gid = shiftHexIdentifier(info.gid!);
    return output;
  }

  private handleSetup(request: HttpRequest): Promise<HttpResponse> {
    return (async () => {
      const requestData = decodePlistBody(request.body as Buffer) ?? {};
      if ("streams" in requestData) return this.handleSetupDataStreamChannel(request, requestData);
      return this.handleSetupEventChannel(request, requestData);
    })();
  }

  private channelKey(request: HttpRequest): string {
    return request.headers.get("DACP-ID") ?? request.headers.get("Active-Remote") ?? request.path;
  }

  private async handleSetupEventChannel(request: HttpRequest, requestData: Record<string, any>): Promise<HttpResponse> {
    const updated = { ...requestData };
    for (const field of ["sessionUUID", "deviceID", "macAddress", "sessionCorrelationUUID"]) {
      if (field in requestData) updated[field] = shiftHexIdentifier(requestData[field]);
    }
    const rewritten = replaceRequest(request, { path: this.rewriteUri(request.path), body: encodePlistBody(updated) });

    const response = await this.sendToAtv(rewritten);
    const responseData = decodePlistBody(response.body as Buffer) ?? {};
    const eventPort = responseData.eventPort;

    const proxyPort = await this.createChannelServer(`Event ${this.channelKey(rewritten)}`, () =>
      this.createEventChannel(eventPort, (info) => this.rewriteInfo(info)),
    );
    LOGGER.debug("Event port: remote=%d, local=%d", eventPort, proxyPort);

    return replaceResponse(response, { body: encodePlistBody({ ...responseData, eventPort: proxyPort }) });
  }

  private async handleSetupDataStreamChannel(request: HttpRequest, requestData: Record<string, any>): Promise<HttpResponse> {
    const rewritten = replaceRequest(request, { path: this.rewriteUri(request.path) });

    const requestStreams = requestData.streams as any[];
    const response = await this.sendToAtv(rewritten);
    const responseData = decodePlistBody(response.body as Buffer) ?? {};
    const responseStreams = responseData.streams as any[];

    const modifiedStreams: any[] = [];
    for (let i = 0; i < Math.min(requestStreams.length, responseStreams.length); i++) {
      const responseStream = responseStreams[i];
      const streamId = responseStream.streamID;
      const streamPort = responseStream.dataPort;
      const streamSeed = requestStreams[i].seed;

      const proxyPort = await this.createChannelServer(`Data stream ${streamId}`, () =>
        this.createDataStreamChannel(streamPort, streamId, streamSeed),
      );
      LOGGER.debug("Data stream %d port: remote=%d, local=%d", streamId, streamPort, proxyPort);
      modifiedStreams.push({ ...responseStream, dataPort: proxyPort });
    }

    return replaceResponse(response, { body: encodePlistBody({ ...responseData, streams: modifiedStreams }) });
  }

  private handleTeardown(request: HttpRequest): Promise<HttpResponse | null> {
    return (async () => {
      const requestData = decodePlistBody(request.body as Buffer) ?? {};
      const rewritten = replaceRequest(request, { path: this.rewriteUri(request.path) });
      try {
        return await this.sendToAtv(rewritten);
      } catch (ex) {
        if ((ex as Error).name !== "TimeoutError") throw ex;
        return null;
      } finally {
        if ("streams" in requestData) {
          for (const stream of requestData.streams) this.destroyChannelServer(`Data stream ${stream.streamID}`);
        } else {
          this.destroyChannelServer(`Event ${this.channelKey(rewritten)}`);
        }
      }
    })();
  }

  private rewriteUri(uri: string): string {
    if (uri.includes("://")) {
      const parts = uri.split("/");
      return [...parts.slice(0, 2), this.connection!.remoteIp, ...parts.slice(3)].join("/");
    }
    return uri;
  }

  /** Dispatch request to correct handler method or proxy to remote device. */
  override handleRequest(request: HttpRequest): HandlerResult {
    logRequest(LOGGER, request);
    const response = super.handleRequest(request);
    if (response !== null && response !== undefined) return response;
    // Generic handling if there was no specific handler
    return this.sendToAtv(replaceRequest(request, { path: this.rewriteUri(request.path) }));
  }

  /** Forward request to remote device (ATV). */
  async sendToAtv(request: HttpRequest): Promise<HttpResponse> {
    await this.connectedEvent.wait();
    const response = await this.connection!.sendAndReceive(request.method, request.path, {
      protocol: `${request.protocol}/${request.version}`,
      headers: headersWithoutContentLength(request.headers.entries()),
      body: typeof request.body === "string" ? request.body : request.body,
    });
    logResponse(LOGGER, response);
    // NB: pyatv uses the request headers in the response here
    return replaceResponse(response, { headers: headersWithoutContentLength(request.headers.entries()) });
  }

  private async createChannelServer(identifier: string, channelFactory: () => AirPlayChannelAppleTVProxy): Promise<number> {
    const server = await createServer(channelFactory, "0.0.0.0", 0);
    this.channelServers.set(identifier, server);
    return server.port;
  }

  private destroyChannelServer(identifier: string): void {
    this.channelServers.get(identifier)?.close();
    this.channelServers.delete(identifier);
  }

  private createEventChannel(port: number, rewriteInfo: (info: Record<string, any>) => Record<string, any>): AirPlayEventChannelAppleTVProxy {
    return new AirPlayEventChannelAppleTVProxy(this.verifier!, this.connection!.remoteIp, port, this.sharedKey!, rewriteInfo);
  }

  private createDataStreamChannel(port: number, streamId: number, seed: bigint | number): AirPlayDataStreamChannelAppleTVProxy {
    return new AirPlayDataStreamChannelAppleTVProxy(
      streamId,
      this.verifier!,
      this.connection!.remoteIp,
      port,
      this.sharedKey!,
      seed,
      this.targetIdentifier,
      this.targetGroup,
    );
  }
}

// --- Relay ---------------------------------------------------------------------------

/** Connection to host of interest. */
class RemoteConnection implements TransportProtocol {
  transport: Transport | null = null;
  callback: RelayConnection | null = null;

  connectionMade(transport: Transport): void {
    LOGGER.debug("Connected to remote host %s", transport.getExtraInfo("peername"));
    this.transport = transport;
  }

  connectionLost(_exc: Error | null): void {
    LOGGER.debug("Disconnected from remote host");
    this.transport = null;
  }

  dataReceived(data: Buffer): void {
    logBinary(LOGGER, "Data from remote", { Data: data });
    this.callback?.transport?.write(data);
  }
}

/** Connection to initiating device, e.g. a phone. */
class RelayConnection implements TransportProtocol {
  transport: Transport | null = null;

  constructor(readonly connection: RemoteConnection) {}

  connectionMade(transport: Transport): void {
    LOGGER.debug("Client connected %s", transport.getExtraInfo("peername"));
    this.transport = transport;
    this.connection.callback = this;
  }

  connectionLost(_exc: Error | null): void {
    LOGGER.debug("Client disconnected");
    this.transport = null;
  }

  dataReceived(data: Buffer): void {
    logBinary(LOGGER, "Data from client", { Data: data });
    this.connection.transport?.write(data);
  }
}

// --- Publishing ----------------------------------------------------------------------

type Unpublisher = () => Promise<void>;

/** Publish zeroconf service for ATV MRP proxy instance. */
function publishMrpService(zconf: Zeroconf, address: string, port: number, name: string): Promise<Unpublisher> {
  const properties = {
    ModelName: "Apple TV",
    AllowPairing: "YES",
    macAddress: "40:cb:c0:12:34:56",
    BluetoothAddress: "False",
    Name: name,
    UniqueIdentifier: SERVER_IDENTIFIER,
    SystemBuildVersion: "17K499",
    LocalAirPlayReceiverPairingIdentity: AIRPLAY_IDENTIFIER,
  };
  return mdns.publish({ type: "_mediaremotetv._tcp.local", name, address, port, properties }, zconf);
}

/** Publish zeroconf service for ATV Companion proxy instance. */
function publishCompanionService(zconf: Zeroconf, address: string, port: number, targetProperties: Record<string, string>): Promise<Unpublisher> {
  const properties = {
    ...targetProperties,
    rpHA: "9948cfb6da55",
    rpHN: "cef88e5db6fa",
    rpAD: "3b2210518c58",
    rpHI: "91756a18d8e5",
    rpBA: BLUETOOTH_ADDRESS,
    rpMRtID: SERVER_IDENTIFIER,
  };
  return mdns.publish({ type: "_companion-link._tcp.local", name: DEVICE_NAME, address, port, properties }, zconf);
}

/** Publish zeroconf service for ATV AirPlay proxy instance. */
function publishAirplayService(zconf: Zeroconf, address: string, port: number, targetProperties: Record<string, string>): Promise<Unpublisher> {
  const properties = AirPlayAppleTVProxy.rewriteDnsTxt(targetProperties);
  return mdns.publish({ type: "_airplay._tcp.local", name: DEVICE_NAME, address, port, properties }, zconf);
}

// --- Proxy start ---------------------------------------------------------------------

async function waitForEnter(): Promise<void> {
  print("Press ENTER to quit");
  await getIO().readline();
}

function localIpReaching(remoteIp: string): string {
  const address = net.getLocalAddressReaching(remoteIp);
  if (address === null) throw new Error(`no local address reaching ${remoteIp}`);
  return String(address);
}

async function findService(remoteIp: string, serviceType: string): Promise<mdns.Service> {
  const resp = await mdns.unicast(remoteIp, [serviceType]);
  const service = resp.services.find((s) => s.type === serviceType);
  if (!service) throw new Error(`service ${serviceType} not found on ${remoteIp}`);
  return service;
}

const propertiesOf = (service: mdns.Service): Record<string, string> =>
  service.properties instanceof Map ? Object.fromEntries(service.properties) : { ...service.properties };

/** Create proxy for each connecting client and start it in the background. */
function startingProxy<T extends { start(): Promise<void> }>(factory: () => T): () => T {
  return () => {
    const proxy = factory();
    proxy.start().catch((ex) => LOGGER.exception("failed to start proxy: %s", ex));
    return proxy;
  };
}

async function startMrpProxy(args: Namespace, zconf: Zeroconf): Promise<Unpublisher> {
  args.local_ip ??= localIpReaching(args.remote_ip);
  LOGGER.debug("Binding to local address %s", args.local_ip);

  if (!(args.remote_port || args.name)) {
    const resp = await mdns.unicast(args.remote_ip, ["_mediaremotetv._tcp.local"]);
    if (!args.remote_port) args.remote_port = resp.services[0]!.port;
    if (!args.name) args.name = resp.services[0]!.name + " Proxy";
  }
  args.name ||= DEVICE_NAME;

  // Setup server used to publish a fake MRP server
  const server = await createServer(
    startingProxy(() => new MrpAppleTVProxy(args.remote_ip, Number(args.remote_port), args.credentials)),
    "0.0.0.0",
    0,
  );
  LOGGER.info("Started MRP server at port %d", server.port);

  const unpublisher = await publishMrpService(zconf, args.local_ip, server.port, args.name);
  await waitForEnter();
  server.close();
  return unpublisher;
}

async function startCompanionProxy(args: Namespace, zconf: Zeroconf): Promise<Unpublisher> {
  args.local_ip ??= localIpReaching(args.remote_ip);
  LOGGER.debug("Binding to local address %s", args.local_ip);

  const service = await findService(args.remote_ip, "_companion-link._tcp.local");
  args.remote_port ||= service.port;

  const server = await createServer(
    startingProxy(() => new CompanionAppleTVProxy(args.remote_ip, Number(args.remote_port), args.credentials)),
    "0.0.0.0",
    0,
  );
  LOGGER.info("Started Companion server at port %d", server.port);

  const properties = Object.fromEntries(Object.entries(propertiesOf(service)).map(([k, v]) => [PROPERTY_CASE_MAP[k] ?? k, v]));
  const unpublisher = await publishCompanionService(zconf, args.local_ip, server.port, properties);
  await waitForEnter();
  server.close();
  return unpublisher;
}

async function startAirplayProxy(args: Namespace, zconf: Zeroconf): Promise<Unpublisher> {
  args.local_ip ??= localIpReaching(args.remote_ip);
  LOGGER.debug("Binding to local address %s", args.local_ip);

  const service = await findService(args.remote_ip, "_airplay._tcp.local");
  args.remote_port ||= service.port;
  const properties = propertiesOf(service);

  const server = await createServer(
    () => {
      const proxy = new AirPlayAppleTVProxy(args.remote_ip, Number(args.remote_port), properties, args.credentials);
      proxy.start().catch((ex) => LOGGER.exception("failed to start proxy: %s", ex));
      return new AirPlayProxyHttpServer(proxy);
    },
    "0.0.0.0",
    0,
  );
  LOGGER.info("Started AirPlay server at port %d", server.port);

  const unpublisher = await publishAirplayService(zconf, args.local_ip, server.port, properties);
  await waitForEnter();
  server.close();
  return unpublisher;
}

async function startRelay(args: Namespace, zconf: Zeroconf): Promise<Unpublisher> {
  const [, protocol] = await createConnection(() => new RemoteConnection(), args.remote_ip, Number(args.remote_port));

  const server = await createServer(() => new RelayConnection(protocol), "0.0.0.0", 0);

  const props: Record<string, string> = {};
  for (const prop of (args.properties as string[] | null) ?? []) {
    const [key, value] = prop.split("=");
    props[key!] = value ?? "";
  }

  const unpublisher = await mdns.publish(
    { type: args.service_type, name: args.name, address: args.local_ip, port: server.port, properties: props },
    zconf,
  );

  await waitForEnter();
  server.close();
  return unpublisher;
}

/** Create parsers for all sub-commands. */
function createParsers(): [ArgumentParser, Map<string, ArgumentParser>] {
  const parser = new ArgumentParser("atvproxy", "sub-commands: mrp (MRP proxy), companion (Companion proxy), airplay (AirPlay proxy), relay (Relay traffic to host)");
  parser.addArgument("command", { choices: ["mrp", "companion", "airplay", "relay"], help: "sub-command" });

  const mrp = new ArgumentParser("atvproxy mrp");
  mrp.addArgument("credentials", { help: "MRP credentials" });
  mrp.addArgument("remote_ip", { help: "Apple TV IP address" });
  mrp.addArgument("--name", { default: null, help: "proxy device name" });
  mrp.addArgument("--local-ip", { default: null, help: "local IP address" });
  mrp.addArgument("--remote_port", { default: null, help: "MRP port" });

  const companion = new ArgumentParser("atvproxy companion");
  companion.addArgument("credentials", { help: "Companion credentials" });
  companion.addArgument("remote_ip", { help: "Apple TV IP address" });
  companion.addArgument("--local_ip", { help: "local IP address" });
  companion.addArgument("--remote_port", { help: "Companion port" });

  const airplay = new ArgumentParser("atvproxy airplay");
  airplay.addArgument("remote_ip", { help: "Apple TV IP address" });
  airplay.addArgument("--credentials", { help: "AirPlay credentials" });
  airplay.addArgument("--local_ip", { help: "local IP address" });
  airplay.addArgument("--remote_port", { help: "AirPlay port" });

  const relay = new ArgumentParser("atvproxy relay");
  relay.addArgument("local_ip", { help: "local IP address" });
  relay.addArgument("remote_ip", { help: "Remote host" });
  relay.addArgument("remote_port", { help: "Remote port" });
  relay.addArgument("name", { help: "Service name" });
  relay.addArgument("service_type", { help: "Service type" });
  relay.addArgument("-p", "--properties", { nargs: "+", help: "Service properties" } as any);

  return [parser, new Map([["mrp", mrp], ["companion", companion], ["airplay", airplay], ["relay", relay]])];
}

/** Run the application and return exit code. */
export async function appstart(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [parser, subparsers] = createParsers();

  let args: Namespace;
  try {
    const index = argv.findIndex((arg) => subparsers.has(arg));
    if (index === -1) {
      if (argv.includes("-h") || argv.includes("--help")) parser.parseArgs(["--help"]);
      parser.error("No command specified");
    }
    args = { command: argv[index]!, ...subparsers.get(argv[index]!)!.parseArgs(argv.slice(index + 1)) };
  } catch (ex) {
    if (ex instanceof SystemExit) return ex.code;
    throw ex;
  }

  // To get logging from pyatv
  const removeHandler = basicConfig(DEBUG);
  try {
    logCurrentVersion();

    const zconf = new Zeroconf();
    let unpublisher: Unpublisher | null = null;
    try {
      if (args.command === "mrp") unpublisher = await startMrpProxy(args, zconf);
      else if (args.command === "companion") unpublisher = await startCompanionProxy(args, zconf);
      else if (args.command === "airplay") unpublisher = await startAirplayProxy(args, zconf);
      else if (args.command === "relay") unpublisher = await startRelay(args, zconf);

      if (unpublisher) await unpublisher();
    } finally {
      zconf.close();
    }
  } finally {
    removeHandler();
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await appstart());
}
