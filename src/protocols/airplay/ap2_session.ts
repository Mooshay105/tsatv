/** Implementation of "high-level" support for an AirPlay 2 session. */

import { randomBytes } from "node:crypto";
import { setupChannel } from "../../auth/hap_channel.ts";
import type { HapCredentials, PairVerifyProcedure } from "../../auth/hap_pairing.ts";
import { heartbeater } from "../../core/protocol.ts";
import { InvalidStateError } from "../../exceptions.ts";
import type { DeviceListener } from "../../interface.ts";
import type { InfoSettings } from "../../settings.ts";
import { createTask, type Task } from "../../support/asyncio.ts";
import { decodeBplistFromBody, type HttpConnection, httpConnect } from "../../support/http.ts";
import { getLogger } from "../../support/logging.ts";
import { RtspSession } from "../../support/rtsp.ts";
import type { StateProducer } from "../../support/state_producer.ts";
import type { Transport } from "../../support/transport.ts";
import { uuid4 } from "../../support/uuid.ts";
import { verifyConnection } from "./auth/index.ts";
import { DataStreamChannel, EventChannel } from "./channels.ts";

const LOGGER = getLogger("pyatv.protocols.airplay.ap2_session");

// This is what iOS uses
export const FEEDBACK_INTERVAL = 2.0; // Seconds

export const EVENTS_SALT = "Events-Salt";
export const EVENTS_WRITE_INFO = "Events-Write-Encryption-Key";
export const EVENTS_READ_INFO = "Events-Read-Encryption-Key";

export const DATASTREAM_SALT = "DataStream-Salt"; // seed must be appended
export const DATASTREAM_OUTPUT_INFO = "DataStream-Output-Encryption-Key";
export const DATASTREAM_INPUT_INFO = "DataStream-Input-Encryption-Key";

/** High-level session for AirPlay 2. */
export class AP2Session {
  connection: HttpConnection | null = null;
  verifier: PairVerifyProcedure | null = null;
  rtsp: RtspSession | null = null;
  dataChannel: DataStreamChannel | null = null;
  private readonly _channels: Transport[] = [];
  private _feedbackTask: Task<void> | null = null;

  constructor(
    private readonly _address: string,
    private readonly _controlPort: number,
    private readonly _credentials: HapCredentials,
    private readonly _info: InfoSettings,
    private readonly _password: string | null = null,
  ) {}

  /** Open connection to receiver. */
  async connect(): Promise<void> {
    LOGGER.debug("Setting up remote connection to %s:%d", this._address, this._controlPort);
    this.connection = await httpConnect(this._address, this._controlPort);
    // Password protected receivers answer the first RTSP request with a digest challenge
    this.connection.password = this._password;
    this.verifier = await verifyConnection(this._credentials, this.connection);
    this.rtsp = new RtspSession(this.connection);
  }

  /** Set up remote control session over the data channel. */
  async setupRemoteControl(): Promise<void> {
    if (this.connection === null || this.rtsp === null) throw new InvalidStateError("not connected to remote");
    await this._setupEventChannel(this.connection.remoteIp);
    await this.rtsp.record();
    await this._setupDataChannel(this.connection.remoteIp);
  }

  /** Start sending keep alive messages. */
  startKeepAlive(deviceListener: StateProducer<DeviceListener>): void {
    // Functions are needed here as accessing a method in the device listener will
    // cause the device listener to handle that as a connection error.
    this._feedbackTask = createTask((signal) =>
      heartbeater(
        `AirPlay:${this._address}`,
        async () => {
          if (this.rtsp) await this.rtsp.feedback();
        },
        {
          finishFunc: () => deviceListener.listener.connectionClosed(),
          failureFunc: (exc) => deviceListener.listener.connectionLost(exc),
          interval: FEEDBACK_INTERVAL,
          signal,
        },
      ),
    );
    this._feedbackTask.promise.catch(() => undefined);
  }

  private async _setup(body: Record<string, unknown>): Promise<Record<string, any>> {
    const resp = await this.rtsp!.setup({ body });
    return decodeBplistFromBody(resp);
  }

  private async _setupEventChannel(address: string): Promise<void> {
    if (this.verifier === null) throw new InvalidStateError("not in connected state");

    const resp = await this._setup({
      isRemoteControlOnly: true,
      osName: this._info.os_name,
      sourceVersion: "550.10",
      timingProtocol: "None",
      model: this._info.model,
      deviceID: this._info.device_id,
      osVersion: this._info.os_version,
      osBuildVersion: this._info.os_build,
      macAddress: this._info.mac,
      sessionUUID: uuid4().toUpperCase(),
      name: this._info.name,
    });

    const eventPort = resp.eventPort;

    // Event channel is not used so we don't care about it (must be set up though).
    // Note: Read/Write info reversed here as connection originates from receiver!
    const [transport] = await setupChannel(
      (out, inp) => new EventChannel(out, inp),
      this.verifier,
      address,
      eventPort,
      EVENTS_SALT,
      EVENTS_READ_INFO,
      EVENTS_WRITE_INFO,
    );
    this._channels.push(transport);
  }

  private async _setupDataChannel(address: string): Promise<void> {
    if (this.verifier === null) throw new InvalidStateError("not in connected state");

    // A 64 bit random seed is included and used as part of the salt in encryption
    const seed = randomBytes(8).readBigUInt64BE();

    const resp = await this._setup({
      streams: [
        {
          controlType: 2,
          channelID: uuid4().toUpperCase(),
          seed,
          clientUUID: uuid4().toUpperCase(),
          type: 130,
          wantsDedicatedSocket: true,
          clientTypeUUID: "1910A70F-DBC0-4242-AF95-115DB30604E1",
        },
      ],
    });

    const dataPort = resp.streams[0].dataPort;

    const [transport, protocol] = await setupChannel(
      (out, inp) => new DataStreamChannel(out, inp),
      this.verifier,
      address,
      dataPort,
      DATASTREAM_SALT + seed.toString(),
      DATASTREAM_OUTPUT_INFO,
      DATASTREAM_INPUT_INFO,
    );
    this._channels.push(transport);
    this.dataChannel = protocol;
  }

  /** Close all open connections. */
  stop(): Set<Promise<unknown>> {
    const tasks = new Set<Promise<unknown>>();
    if (this._feedbackTask) {
      this._feedbackTask.cancel();
      tasks.add(this._feedbackTask.promise.catch(() => undefined));
      this._feedbackTask = null;
    }
    if (this.connection) {
      this.connection.close();
      this.connection = null;
    }
    for (const channel of this._channels) channel.close();
    return tasks;
  }
}
