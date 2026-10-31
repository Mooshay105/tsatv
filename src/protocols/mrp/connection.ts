/** Network layer for MRP. */

import { NotSupportedError } from "../../exceptions.ts";
import * as chacha20 from "../../support/chacha20.ts";
import { logBinary, logProtobuf } from "../../support/index.ts";
import { getLogger } from "../../support/logging.ts";
import { tcpKeepalive } from "../../support/net.ts";
import { StateProducer } from "../../support/state_producer.ts";
import { createConnection, type Protocol, type Transport } from "../../support/transport.ts";
import { writeVariant } from "../../support/variant.ts";
import * as pb from "./protobuf/index.ts";

const LOGGER = getLogger("pyatv.protocols.mrp.connection");

/** Listener for messages received over a connection. */
export interface MrpConnectionListener {
  messageReceived(message: pb.ProtocolMessage, data: Buffer): void;
  stop(): void;
}

/** Abstract base class for an MRP connection. */
export abstract class AbstractMrpConnection extends StateProducer<MrpConnectionListener> {
  /** Connect to device. */
  abstract connect(): Promise<void>;

  /** Enable encryption with the specified keys. */
  abstract enableEncryption(outputKey: Uint8Array, inputKey: Uint8Array): void;

  /** If a connection is open or not. */
  abstract get connected(): boolean;

  /** Close connection to device. */
  abstract close(): void;

  /** Send protobuf message to device. */
  abstract send(message: pb.ProtocolMessage): void;
}

/** Read a varint, returns null if more data is needed. */
function tryReadVariant(data: Buffer): [number, number] | null {
  let result = 0;
  for (let i = 0; i < data.length && i < 10; i++) {
    result += (data[i]! & 0x7f) * 2 ** (7 * i);
    if (!(data[i]! & 0x80)) return [result, i + 1];
  }
  return null;
}

/** Network layer that encrypts/decrypts and (de)serializes messages. */
export class MrpConnection extends AbstractMrpConnection implements Protocol {
  private _logStr = "";
  private _buffer: Buffer = Buffer.alloc(0);
  private _chacha: chacha20.Chacha20Cipher8byteNonce | null = null;
  private _transport: Transport | null = null;

  constructor(
    readonly host: string,
    readonly port: number,
    readonly atv: StateProducer<any> | null = null,
  ) {
    super();
  }

  connectionMade(transport: Transport): void {
    LOGGER.debug("Connection made to device");
    this._transport = transport;
    try {
      tcpKeepalive(transport.getExtraInfo("socket"));
    } catch (ex) {
      if (ex instanceof NotSupportedError) LOGGER.warning("Keep-alive not supported: %s", ex.message);
      else throw ex;
    }

    const [dstaddr, dstport] = transport.getExtraInfo("peername");
    const [srcaddr, srcport] = transport.getExtraInfo("sockname");
    this._logStr = `${srcaddr}:${srcport}<->${dstaddr}:${dstport} `;
    LOGGER.debug("%s Connection established", this._logStr);
  }

  connectionLost(exc: Error | null): void {
    LOGGER.debug("%s Disconnected from device: %s", this._logStr, exc);
    this._transport = null;
    this.listener.stop();

    if (this.atv) {
      if (exc === null) this.atv.listener.connectionClosed();
      else this.atv.listener.connectionLost(exc);
    }
  }

  eofReceived(): void {
    LOGGER.debug("%s Received EOF from server", this._logStr);
    this._transport?.close();
  }

  enableEncryption(outputKey: Uint8Array, inputKey: Uint8Array): void {
    this._chacha = new chacha20.Chacha20Cipher8byteNonce(outputKey, inputKey);
  }

  get connected(): boolean {
    return this._transport !== null;
  }

  async connect(): Promise<void> {
    await createConnection(() => this, this.host, this.port);
  }

  close(): void {
    LOGGER.debug("%s Closing connection", this._logStr);
    this._transport?.close();
    this._transport = null;
    this._chacha = null;
  }

  send(message: pb.ProtocolMessage): void {
    let serialized = message.serializeToString();

    logBinary(LOGGER, this._logStr + ">> Send", { Data: serialized });
    if (this._chacha) {
      serialized = this._chacha.encrypt(serialized);
      logBinary(LOGGER, this._logStr + ">> Send", { Encrypted: serialized });
    }

    this._transport?.write(Buffer.concat([writeVariant(serialized.length), serialized]));
    logProtobuf(LOGGER, this._logStr + ">> Send: Protobuf", message);
  }

  /** Send raw data to device. */
  sendRaw(data: Uint8Array): void {
    let out: Buffer = Buffer.from(data);
    logBinary(LOGGER, this._logStr + ">> Send raw", { Data: out });
    if (this._chacha) {
      out = this._chacha.encrypt(out);
      logBinary(LOGGER, this._logStr + ">> Send raw", { Encrypted: out });
    }
    this._transport?.write(Buffer.concat([writeVariant(out.length), out]));
  }

  dataReceived(data: Buffer): void {
    // A message might be split over several reads, so we store a buffer and try to
    // decode messages from that buffer
    this._buffer = Buffer.concat([this._buffer, data]);
    logBinary(LOGGER, this._logStr + "<< Receive", { Data: data });

    while (this._buffer.length > 0) {
      // The variant tells us how much data must follow
      const variant = tryReadVariant(this._buffer);
      if (variant === null) break;
      const [length, headerLength] = variant;
      if (this._buffer.length - headerLength < length) {
        LOGGER.debug(
          "%s Require %d bytes but only %d in buffer",
          this._logStr,
          length,
          this._buffer.length - headerLength,
        );
        break;
      }

      const message = this._buffer.subarray(headerLength, headerLength + length);
      this._buffer = this._buffer.subarray(headerLength + length);

      try {
        this._handleMessage(Buffer.from(message));
      } catch (ex) {
        LOGGER.error("%s Failed to handle message: %s", this._logStr, ex);
      }
    }
  }

  private _handleMessage(data: Buffer): void {
    let decrypted = data;
    if (this._chacha) {
      decrypted = this._chacha.decrypt(data);
      logBinary(LOGGER, this._logStr + "<< Receive", { Decrypted: decrypted });
    }

    const parsed = pb.ProtocolMessage.decode(decrypted);
    logProtobuf(LOGGER, this._logStr + "<< Receive: Protobuf", parsed);
    this.listener.messageReceived(parsed, decrypted);
  }

  override toString(): string {
    return `MRP:${this.host}`;
  }
}
