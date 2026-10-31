/** Connection abstraction for Companion protocol. */

import { InvalidStateError } from "../../exceptions.ts";
import * as chacha20 from "../../support/chacha20.ts";
import { logBinary } from "../../support/index.ts";
import { getLogger } from "../../support/logging.ts";
import type { StateProducer } from "../../support/state_producer.ts";
import { createConnection, type Protocol, type Transport } from "../../support/transport.ts";

const LOGGER = getLogger("pyatv.protocols.companion.connection");

export const AUTH_TAG_LENGTH = 16;
export const HEADER_LENGTH = 4;

/** Frame type values. */
export enum FrameType {
  Unknown = 0,
  NoOp = 1,
  PS_Start = 3,
  PS_Next = 4,
  PV_Start = 5,
  PV_Next = 6,
  U_OPACK = 7,
  E_OPACK = 8,
  P_OPACK = 9,
  PA_Req = 10,
  PA_Rsp = 11,
  SessionStartRequest = 16,
  SessionStartResponse = 17,
  SessionData = 18,
  FamilyIdentityRequest = 32,
  FamilyIdentityResponse = 33,
  FamilyIdentityUpdate = 34,
}

/** Listener interface for a Companion connection. */
export interface CompanionConnectionListener {
  /** Frame was received from remote device. */
  frameReceived(frameType: FrameType, data: Buffer): void;
}

/** Remote connection to a Companion device. */
export class CompanionConnection implements Protocol {
  transport: Transport | null = null;
  private _listener: CompanionConnectionListener | null = null;
  private _buffer: Buffer = Buffer.alloc(0);
  private _chacha: chacha20.Chacha20Cipher | null = null;

  constructor(
    readonly host: string,
    readonly port: number,
    private readonly _deviceListener: StateProducer<any> | null = null,
  ) {}

  /** If a connection is open or not. */
  get connected(): boolean {
    return this.transport !== null;
  }

  /** Connect to device. */
  async connect(): Promise<void> {
    await createConnection(() => this, this.host, this.port);
  }

  /** Close connection to device. */
  close(): void {
    LOGGER.debug("Closing connection");
    if (this.transport) {
      this.transport.close();
      this.transport = null;
    }
  }

  /** Enable encryption with the specified keys. */
  enableEncryption(outputKey: Uint8Array, inputKey: Uint8Array): void {
    this._chacha = new chacha20.Chacha20Cipher(outputKey, inputKey, 12);
  }

  setListener(listener: CompanionConnectionListener): void {
    this._listener = listener;
  }

  /** Send message without waiting for a response. */
  send(frameType: FrameType, data: Uint8Array): void {
    if (this.transport === null) throw new InvalidStateError("not connected");

    let payloadLength = data.length;
    if (this._chacha && payloadLength > 0) payloadLength += AUTH_TAG_LENGTH;
    const header = Buffer.alloc(4);
    header[0] = frameType;
    header.writeUIntBE(payloadLength, 1, 3);

    logBinary(LOGGER, ">> Send data", { FrameType: Buffer.from([frameType]), Data: data });

    let payload: Buffer = Buffer.from(data);
    if (this._chacha && data.length > 0) {
      payload = this._chacha.encrypt(data, null, header);
      logBinary(LOGGER, ">> Send", { Header: header, Encrypted: payload });
    }

    this.transport.write(Buffer.concat([header, payload]));
  }

  connectionMade(transport: Transport): void {
    LOGGER.debug("Connected to companion device %s:%d", this.host, this.port);
    this.transport = transport;
  }

  /** Handle data received from companion. */
  dataReceived(data: Buffer): void {
    this._buffer = Buffer.concat([this._buffer, data]);
    logBinary(LOGGER, "Received data", { Data: data });

    while (this._buffer.length >= HEADER_LENGTH) {
      const payloadLength = HEADER_LENGTH + this._buffer.readUIntBE(1, 3);
      if (this._buffer.length < payloadLength) {
        LOGGER.debug("Require %d bytes but only %d in buffer", payloadLength, this._buffer.length);
        break;
      }

      const header = this._buffer.subarray(0, HEADER_LENGTH);
      let payload = this._buffer.subarray(HEADER_LENGTH, payloadLength);
      this._buffer = this._buffer.subarray(payloadLength);

      try {
        if (this._chacha && payload.length > 0) payload = this._chacha.decrypt(payload, null, header);
        this._listener?.frameReceived(header[0] as FrameType, Buffer.from(payload));
      } catch (ex) {
        LOGGER.exception("failed to handle frame: %s", ex);
      }
    }
  }

  errorReceived(exc: Error): void {
    LOGGER.debug("Connection error: %s", exc);
  }

  /** Handle that connection was lost from companion. */
  connectionLost(exc: Error | null): void {
    LOGGER.debug("Connection lost to remote device: %s", exc);
    this.transport = null;
    if (this._deviceListener !== null) {
      if (exc) this._deviceListener.listener.connectionLost(exc);
      else this._deviceListener.listener.connectionClosed();
    }
  }
}
