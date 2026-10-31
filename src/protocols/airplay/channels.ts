/** Logic related to logical AirPlay channels (AirPlay 2). */

import { randomBytes } from "node:crypto";
import { AbstractHAPChannel } from "../../auth/hap_channel.ts";
import {
  formatRequest,
  formatResponse,
  type HttpRequest,
  HttpResponse,
  parseRequest,
  parseResponse,
} from "../../support/http.ts";
import { getLogger } from "../../support/logging.ts";
import { defpacket } from "../../support/packet.ts";
import { writeVariant } from "../../support/variant.ts";
import * as pb from "../mrp/protobuf/index.ts";
import { decodePlistBody, encodePlistBody } from "./utils.ts";

const LOGGER = getLogger("pyatv.protocols.airplay.channels");

export const DATA_HEADER_PADDING = 0x00000000;

export const DataHeader = defpacket<{ size: number; messageType: Buffer; command: Buffer; seqno: bigint; padding: number }>(
  "DataFrame",
  { size: "I", messageType: "12s", command: "4s", seqno: "Q", padding: "I" },
);

/** Base class for connection used to handle the event channel. */
export abstract class BaseEventChannel extends AbstractHAPChannel {
  static formatRequest(request: HttpRequest): Buffer {
    return formatRequest(request);
  }

  static parseRequest(data: Buffer): [HttpRequest | null, Buffer, Buffer] {
    const [request, rest] = parseRequest(data);
    return [request, data.subarray(0, data.length - rest.length), rest];
  }

  static formatResponse(response: HttpResponse): Buffer {
    return formatResponse(response);
  }

  static parseResponse(data: Buffer): [HttpResponse | null, Buffer, Buffer] {
    const [response, rest] = parseResponse(data);
    return [response, data.subarray(0, data.length - rest.length), rest];
  }
}

/** Connection used to handle the event channel. */
export class EventChannel extends BaseEventChannel {
  handleReceived(): void {
    while (this.buffer.length > 0) {
      try {
        const [request, , rest] = BaseEventChannel.parseRequest(this.buffer);
        this.buffer = rest;
        if (request === null) {
          LOGGER.debug("Not enough data to parse request on event channel");
          break;
        }

        LOGGER.debug("Got message on event channel: %s", request);

        // Send a positive response to satisfy the other end of the channel
        const headers: Record<string, string> = { "Content-Length": "0", "Audio-Latency": "0" };
        if (request.headers.has("Server")) headers.Server = request.headers.get("Server")!;
        if (request.headers.has("CSeq")) headers.CSeq = request.headers.get("CSeq")!;
        this.send(
          BaseEventChannel.formatResponse(
            new HttpResponse(request.protocol, request.version, 200, "OK", headers, Buffer.alloc(0)),
          ),
        );
      } catch (ex) {
        LOGGER.error("Failed to handle message on event channel: %s", ex);
        break;
      }
    }
  }
}

/** Listener interface for DataStreamChannel. */
export interface DataStreamListener {
  handleProtobuf(message: pb.ProtocolMessage): void;
  handleConnectionLost(exc: Error | null): void;
}

/** Data stream channel message. */
export interface DataStreamMessage {
  messageType: Buffer;
  command: Buffer;
  seqno: bigint;
  padding: number;
  payload: Buffer;
}

/** Base class for connection used to handle the data stream channel. */
export abstract class BaseDataStreamChannel extends AbstractHAPChannel<DataStreamListener> {
  static encodeMessage(message: DataStreamMessage): Buffer {
    return Buffer.concat([
      DataHeader.encode(
        DataHeader.length + message.payload.length,
        message.messageType,
        message.command,
        message.seqno,
        message.padding,
      ),
      message.payload,
    ]);
  }

  static encodePayload(payload: unknown): Buffer {
    return encodePlistBody(payload);
  }

  static encodeProtobufs(messages: pb.ProtocolMessage[]): Buffer {
    const parts: Buffer[] = [];
    for (const message of messages) {
      const serialized = message.serializeToString();
      parts.push(writeVariant(serialized.length), serialized);
    }
    return Buffer.concat(parts);
  }

  encodeReply(seqno: bigint): Buffer {
    return BaseDataStreamChannel.encodeMessage({
      messageType: Buffer.concat([Buffer.from("rply"), Buffer.alloc(8)]),
      command: Buffer.alloc(4),
      seqno,
      padding: DATA_HEADER_PADDING,
      payload: Buffer.alloc(0),
    });
  }

  static decodeMessage(data: Buffer): [DataStreamMessage | null, Buffer, Buffer] {
    if (data.length < DataHeader.length) return [null, Buffer.alloc(0), data];
    const header = DataHeader.decode(data, true);
    if (data.length < header.size) {
      LOGGER.debug("Not enough data on data channel (has %d, expects %d)", data.length, header.size);
      return [null, Buffer.alloc(0), data];
    }
    return [
      {
        messageType: header.messageType,
        command: header.command,
        seqno: header.seqno,
        padding: header.padding,
        payload: data.subarray(DataHeader.length, header.size),
      },
      data.subarray(0, header.size),
      data.subarray(header.size),
    ];
  }

  static decodePayload(payload: Buffer): any {
    const data = decodePlistBody(payload);
    if (data === null) LOGGER.warning("failed to process data frame");
    return data;
  }

  static decodeProtobufs(data: Buffer): pb.ProtocolMessage[] {
    const messages: pb.ProtocolMessage[] = [];
    let rest = data;
    try {
      while (rest.length > 0) {
        // Every message must include type (field #1), encoded with tag 0x08. This is
        // not a valid length since the minimal message length is at least 40. We can
        // use this to detect cases where the message is not length prefixed, which is
        // known to happen for ConfigureConnectionMessage.
        let message: Buffer;
        if (rest[0] === 0x8) {
          message = rest;
          rest = Buffer.alloc(0);
        } else {
          let length = 0;
          let header = 0;
          for (let i = 0; i < rest.length; i++) {
            length += (rest[i]! & 0x7f) * 2 ** (7 * i);
            if (!(rest[i]! & 0x80)) {
              header = i + 1;
              break;
            }
          }
          if (rest.length - header < length) {
            LOGGER.warning("Expected %d bytes, got %d", length, rest.length - header);
            break;
          }
          message = rest.subarray(header, header + length);
          rest = rest.subarray(header + length);
        }
        if (message[0] !== 0x8) throw new Error("invalid protobuf message");
        messages.push(pb.ProtocolMessage.decode(message));
      }
    } catch (ex) {
      LOGGER.error("failed to process data frame: %s", ex);
    }
    return messages;
  }
}

/** Connection used to handle the data stream channel. */
export class DataStreamChannel extends BaseDataStreamChannel {
  sendSeqno: bigint;

  constructor(outputKey: Uint8Array, inputKey: Uint8Array) {
    super(outputKey, inputKey);
    // randrange(0x100000000, 0x1FFFFFFFF)
    this.sendSeqno = 0x100000000n + BigInt(randomBytes(4).readUInt32BE() % 0xffffffff);
  }

  override connectionLost(exc: Error | null): void {
    this.listener.handleConnectionLost(exc);
  }

  handleReceived(): void {
    while (this.buffer.length >= DataHeader.length) {
      const [message, , rest] = BaseDataStreamChannel.decodeMessage(this.buffer);
      if (!message) break;
      this.buffer = rest;

      const payload = BaseDataStreamChannel.decodePayload(message.payload);
      if (payload) this._processPayload(payload);

      // If this was a request, send a reply to satisfy other end
      if (message.messageType.subarray(0, 4).toString("latin1") === "sync") {
        this.send(this.encodeReply(message.seqno));
      }
    }
  }

  private _processPayload(message: any): void {
    const data = message?.params?.data;
    if (data === undefined || data === null) {
      LOGGER.debug("Got message with unsupported format: %s", message);
      return;
    }
    for (const pbMsg of BaseDataStreamChannel.decodeProtobufs(data)) this.listener.handleProtobuf(pbMsg);
  }

  /** Serialize a protobuf message and send it to receiver. */
  sendProtobuf(message: pb.ProtocolMessage): void {
    this.send(
      BaseDataStreamChannel.encodeMessage({
        messageType: Buffer.concat([Buffer.from("sync"), Buffer.alloc(8)]),
        command: Buffer.from("comm"),
        seqno: this.sendSeqno,
        padding: DATA_HEADER_PADDING,
        payload: BaseDataStreamChannel.encodePayload({
          params: { data: BaseDataStreamChannel.encodeProtobufs([message]) },
        }),
      }),
    );
  }
}
