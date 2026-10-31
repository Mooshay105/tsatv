/** Base class for HAP based channels (connections). */

import { InvalidStateError } from "../exceptions.ts";
import { logBinary } from "../support/index.ts";
import { getLogger } from "../support/logging.ts";
import { StateProducer } from "../support/state_producer.ts";
import { createConnection, type Protocol, type Transport } from "../support/transport.ts";
import type { PairVerifyProcedure } from "./hap_pairing.ts";
import { HAPSession } from "./hap_session.ts";

const LOGGER = getLogger("pyatv.auth.hap_channel");

/** Abstract base class for connections using HAP encryption and segmenting. */
export abstract class AbstractHAPChannel<L extends object = any> extends StateProducer<L> implements Protocol {
  buffer: Buffer = Buffer.alloc(0);
  transport: Transport | null = null;
  session: HAPSession = new HAPSession();

  constructor(outputKey: Uint8Array, inputKey: Uint8Array) {
    super();
    this.session.enable(outputKey, inputKey);
  }

  /** Remote connection port number. */
  get port(): number {
    if (this.transport === null) throw new InvalidStateError("not connected");
    return this.transport.getExtraInfo("peername")[1];
  }

  /** Close the channel. */
  close(): void {
    if (this.transport) {
      this.transport.close();
      this.transport = null;
    }
  }

  connectionMade(transport: Transport): void {
    const [dstaddr, dstport] = transport.getExtraInfo("peername");
    LOGGER.debug("Connected to %s:%d", dstaddr, dstport);
    this.transport = transport;
  }

  dataReceived(data: Buffer): void {
    logBinary(LOGGER, "Received data", { Data: data });
    const decrypt = this.session.decrypt(data);
    if (decrypt.length > 0) {
      this.buffer = Buffer.concat([this.buffer, decrypt]);
      this.handleReceived();
    }
  }

  /** Handle received data that was put in buffer. */
  abstract handleReceived(): void;

  /** Send message to device. */
  send(data: Uint8Array): void {
    if (this.transport === null) throw new InvalidStateError("not connected");
    const encrypted = this.session.encrypt(data);
    logBinary(LOGGER, "Sending data", { Encrypted: encrypted });
    this.transport.write(encrypted);
  }

  connectionLost(_exc: Error | null): void {
    LOGGER.debug("Connection was lost to remote");
  }
}

/** Set up a new HAP channel and enable encryption. */
export async function setupChannel<T extends AbstractHAPChannel>(
  factory: (outKey: Buffer, inKey: Buffer) => T,
  verifier: PairVerifyProcedure,
  address: string,
  port: number,
  salt: string,
  outputInfo: string,
  inputInfo: string,
): Promise<[Transport, T]> {
  const [outKey, inKey] = verifier.encryptionKeys(salt, outputInfo, inputInfo);
  return createConnection(() => factory(outKey, inKey), address, port);
}
