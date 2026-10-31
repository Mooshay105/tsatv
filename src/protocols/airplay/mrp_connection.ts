/** MRP connection implemented as a channel/stream over AirPlay. */

import { InvalidStateError } from "../../exceptions.ts";
import { logProtobuf } from "../../support/index.ts";
import { getLogger } from "../../support/logging.ts";
import type { StateProducer } from "../../support/state_producer.ts";
import { AbstractMrpConnection } from "../mrp/connection.ts";
import type * as pb from "../mrp/protobuf/index.ts";
import type { AP2Session } from "./ap2_session.ts";
import type { DataStreamChannel, DataStreamListener } from "./channels.ts";

const LOGGER = getLogger("pyatv.protocols.airplay.mrp_connection");

/** Transparent connection/channel for transporting MRP messages. */
export class AirPlayMrpConnection extends AbstractMrpConnection implements DataStreamListener {
  dataChannel: DataStreamChannel | null = null;

  constructor(
    readonly session: AP2Session,
    readonly deviceListener: StateProducer<any> | null = null,
  ) {
    super();
  }

  connectionLost(exc: Error | null): void {
    this.handleConnectionLost(exc);
  }

  async connect(): Promise<void> {
    if (this.session.dataChannel === null) throw new InvalidStateError("remote control channel not connected");
    this.dataChannel = this.session.dataChannel;
    this.dataChannel.listener = this;
  }

  enableEncryption(_outputKey: Uint8Array, _inputKey: Uint8Array): void {}

  get connected(): boolean {
    return true;
  }

  close(): void {
    if (this.dataChannel !== null) {
      LOGGER.debug("Closing connection");
      this.dataChannel.close();
      this.dataChannel = null;
    }
  }

  send(message: pb.ProtocolMessage): void {
    if (this.dataChannel !== null) {
      this.dataChannel.sendProtobuf(message);
      logProtobuf(LOGGER, ">> Send: Protobuf", message);
    }
  }

  handleProtobuf(message: pb.ProtocolMessage): void {
    logProtobuf(LOGGER, "<< Receive: Protobuf", message);
    this.listener.messageReceived(message, Buffer.alloc(0));
  }

  handleConnectionLost(exc: Error | null): void {
    LOGGER.debug("Disconnected from device: %s", exc);
    if (this.deviceListener) {
      if (exc === null) this.deviceListener.listener.connectionClosed();
      else this.deviceListener.listener.connectionLost(exc);
    }
  }
}
