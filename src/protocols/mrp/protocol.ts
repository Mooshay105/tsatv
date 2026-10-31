/** Implementation of the MRP protocol. */

import { parseCredentials } from "../../auth/hap_pairing.ts";
import type { SRPAuthHandler } from "../../auth/hap_srp.ts";
import { heartbeater, MessageDispatcher } from "../../core/protocol.ts";
import { AuthenticationError, InvalidStateError } from "../../exceptions.ts";
import type { BaseService } from "../../interface.ts";
import type { InfoSettings } from "../../settings.ts";
import { abortableSleep, CancelledError, createTask, Event, type Task, waitFor } from "../../support/asyncio.ts";
import { errorHandler } from "../../support/index.ts";
import { getLogger } from "../../support/logging.ts";
import { uuid4 } from "../../support/uuid.ts";
import { MrpPairVerifyProcedure } from "./auth.ts";
import type { AbstractMrpConnection, MrpConnectionListener } from "./connection.ts";
import * as messages from "./messages.ts";
import * as pb from "./protobuf/index.ts";

const LOGGER = getLogger("pyatv.protocols.mrp.protocol");

export const HEARTBEAT_INTERVAL = 30;
export const HEARTBEAT_RETRIES = 1; // One regular attempt + retries

export const SRP_SALT = "MediaRemote-Salt";
export const SRP_OUTPUT_INFO = "MediaRemote-Write-Encryption-Key";
export const SRP_INPUT_INFO = "MediaRemote-Read-Encryption-Key";

/** Hooks replaceable in tests (heartbeats are stubbed in most tests). */
export const mrpProtocolHooks = {
  heartbeater,
};

/** Periodically send heartbeat messages to device (legacy implementation). */
export async function heartbeatLoop(
  protocol: { sendAndReceive(message: pb.ProtocolMessage): Promise<unknown>; connection: { close(): void } },
  signal?: AbortSignal,
): Promise<void> {
  LOGGER.debug("Starting heartbeat loop");
  let count = 0;
  let attempts = 0;
  const message = messages.create(pb.GENERIC_MESSAGE);
  while (!signal?.aborted) {
    try {
      // Re-attempts are made with no initial delay to more quickly recover a failed
      // heartbeat (if possible)
      if (attempts === 0) await abortableSleep(HEARTBEAT_INTERVAL, signal);

      LOGGER.debug("Sending periodic heartbeat %d", count);
      await protocol.sendAndReceive(message);
      LOGGER.debug("Got heartbeat %d", count);
      attempts = 0;
    } catch (ex) {
      if (ex instanceof CancelledError) break;
      attempts += 1;
      if (attempts > HEARTBEAT_RETRIES) {
        LOGGER.error("heartbeat %d failed after %d tries", count, attempts);
        protocol.connection.close();
        break;
      }
      LOGGER.debug("heartbeat %d failed", count);
    } finally {
      count += 1;
    }
  }
  LOGGER.debug("Stopping heartbeat loop at %d", count);
}

interface OutstandingMessage {
  event: Event;
  response: pb.ProtocolMessage;
}

/** Protocol internal state. */
export enum ProtocolState {
  NOT_CONNECTED = 0,
  CONNECTING = 1,
  CONNECTED = 2,
  READY = 3,
  STOPPED = 4,
}

/**
 * Protocol logic related to MRP.
 *
 * This class wraps an MrpConnection instance and will automatically:
 * - Connect whenever it is needed
 * - Send necessary messages automatically, e.g. DEVICE_INFORMATION
 * - Enable encryption at the right time
 *
 * It provides an API for sending and receiving messages.
 */
export class MrpProtocol extends MessageDispatcher<number, pb.ProtocolMessage> implements MrpConnectionListener {
  deviceInfo: pb.ProtocolMessage | null = null;
  private _heartbeatTask: Task<void> | null = null;
  private _outstanding = new Map<string, OutstandingMessage>();
  private _state = ProtocolState.NOT_CONNECTED;

  constructor(
    readonly connection: AbstractMrpConnection,
    readonly srp: SRPAuthHandler,
    readonly service: BaseService,
    readonly info: InfoSettings,
  ) {
    super();
    this.connection.listener = this;
  }

  /** Connect to device and listen to incoming messages. */
  async start(skipInitialMessages = false): Promise<void> {
    if (this._state !== ProtocolState.NOT_CONNECTED) {
      throw new InvalidStateError(ProtocolState[this._state]);
    }

    this._state = ProtocolState.CONNECTING;

    try {
      await this.connection.connect();

      this._state = ProtocolState.CONNECTED;

      // In case credentials have been given externally (i.e. not by pairing with a
      // device), then use that client id
      if (this.service.credentials) {
        this.srp.pairingId = parseCredentials(this.service.credentials).clientId;
      }

      // The first message must always be DEVICE_INFORMATION, otherwise the device
      // will not respond with anything
      this.deviceInfo = await this.sendAndReceive(
        messages.deviceInformation(this.info, this.srp.pairingId.toString("utf-8")),
      );

      // Distribute the device information to all listeners (as the sendAndReceive
      // will stop that propagation).
      this.dispatch(pb.DEVICE_INFO_MESSAGE, this.deviceInfo);

      // This is a hack to support reuse of a protocol object in proxy
      if (skipInitialMessages) return;

      await errorHandler(() => this._enableEncryption(), AuthenticationError);

      // This should be the first message sent after encryption has been enabled
      await this.send(messages.setConnectionState());

      // Subscribe to updates at this stage
      await this.sendAndReceive(messages.clientUpdatesConfig());
      await this.sendAndReceive(messages.getKeyboardSession());
    } catch (ex) {
      // Something went wrong, let's do cleanup
      this.stop();
      throw ex;
    }

    // We're now ready
    this._state = ProtocolState.READY;
  }

  /** Disconnect from device. */
  stop(): void {
    if (this._outstanding.size > 0) {
      LOGGER.warning("There were %d outstanding requests", this._outstanding.size);
    }

    if (this._heartbeatTask !== null) {
      this._heartbeatTask.cancel();
      this._heartbeatTask = null;
    }
    this._outstanding = new Map();
    this.connection.close();
    this._state = ProtocolState.STOPPED;
  }

  /** Enable sending periodic heartbeat messages. */
  enableHeartbeat(): void {
    const senderFunc = async (message: pb.ProtocolMessage | null) => {
      if (message !== null) await this.sendAndReceive(message);
    };

    this._heartbeatTask = createTask((signal) =>
      mrpProtocolHooks.heartbeater(String(this.connection), senderFunc, {
        failureFunc: () => this.connection.close(),
        messageFactory: () => messages.create(pb.GENERIC_MESSAGE),
        signal,
      }),
    );
    this._heartbeatTask.promise.catch(() => undefined);
  }

  private async _enableEncryption(): Promise<void> {
    // Encryption can be enabled whenever credentials are available but only after
    // DEVICE_INFORMATION has been sent
    if (this.service.credentials === null) return;

    // Verify credentials and generate keys
    const credentials = parseCredentials(this.service.credentials);
    const pairVerifier = new MrpPairVerifyProcedure(this, this.srp, credentials);

    await pairVerifier.verifyCredentials();
    const [outputKey, inputKey] = pairVerifier.encryptionKeys(SRP_SALT, SRP_OUTPUT_INFO, SRP_INPUT_INFO);
    this.connection.enableEncryption(outputKey, inputKey);
  }

  /** Send a message and expect no response. */
  async send(message: pb.ProtocolMessage): Promise<void> {
    if (this._state !== ProtocolState.CONNECTED && this._state !== ProtocolState.READY) {
      throw new InvalidStateError(ProtocolState[this._state]);
    }
    this.connection.send(message);
  }

  /** Send a message and wait for a response. */
  async sendAndReceive(message: pb.ProtocolMessage, generateIdentifier = true, timeout = 5.0): Promise<pb.ProtocolMessage> {
    if (this._state !== ProtocolState.CONNECTED && this._state !== ProtocolState.READY) {
      throw new InvalidStateError(ProtocolState[this._state]);
    }

    // Some messages will respond with the same identifier as used in the
    // corresponding request. Others will not and one example is the crypto message
    // (for pairing). In those cases, a "fake" identifier is used that includes the
    // message type instead.
    let identifier: string;
    if (generateIdentifier) {
      identifier = uuid4().toUpperCase();
      message.identifier = identifier;
    } else {
      identifier = "type_" + String(message.type);
    }

    // Register before sending so that a fast response is not missed
    const outstanding: OutstandingMessage = { event: new Event(), response: new pb.ProtocolMessage() };
    this._outstanding.set(identifier, outstanding);
    this.connection.send(message);
    return this._receive(identifier, outstanding, timeout);
  }

  private async _receive(identifier: string, outstanding: OutstandingMessage, timeout: number): Promise<pb.ProtocolMessage> {
    try {
      // The connection instance will dispatch the message
      await waitFor(outstanding.event.wait(), timeout);
    } finally {
      if (this._outstanding.get(identifier) === outstanding) this._outstanding.delete(identifier);
    }
    return outstanding.response;
  }

  /** Message was received from device. */
  messageReceived(message: pb.ProtocolMessage, _data: Buffer): void {
    // If the message identifier is outstanding, then someone is waiting for the
    // response so we save it here
    const identifier = message.identifier || "type_" + String(message.type);
    const outstanding = this._outstanding.get(identifier);
    if (outstanding) {
      outstanding.response = message;
      outstanding.event.set();
    } else {
      this.dispatch(message.type, message);
    }
  }
}
