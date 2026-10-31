/**
 * Minimal mDNS responder used to publish services (python-zeroconf replacement).
 *
 * Only supports what pyatv needs: registering services (PTR, SRV, TXT and A records)
 * and answering queries for them on the local network.
 */

import type dgram from "node:dgram";
import { DnsMessage, DnsResource, formatTxtDict, QueryType, qnameEncode } from "./dns.ts";
import { ipToBytes } from "./ip.ts";
import { getLogger } from "./logging.ts";
import { mcastSocket } from "./net.ts";

const LOGGER = getLogger("pyatv.support.zeroconf");

const MDNS_ADDRESS = "224.0.0.251";
const MDNS_PORT = 5353;
const TTL = 120;
const CLASS_IN = 1;
const CLASS_IN_UNIQUE = 0x8001;

function stripDot(name: string): string {
  return name.endsWith(".") ? name.slice(0, -1) : name;
}

/** Information about a service to publish. */
export class ServiceInfo {
  readonly type: string;
  readonly name: string;

  constructor(
    type: string,
    name: string,
    readonly addresses: string[],
    readonly port: number,
    readonly properties: Record<string, string | Uint8Array | null> = {},
    readonly server: string | null = null,
  ) {
    // Accept names with or without trailing dot (like python-zeroconf)
    this.type = stripDot(type);
    this.name = stripDot(name);
  }

  /** Instance name (name without type). */
  get instanceName(): string {
    return this.name.endsWith("." + this.type) ? this.name.slice(0, -(this.type.length + 1)) : this.name;
  }

  get serverName(): string {
    return stripDot(this.server ?? `${this.instanceName.replace(/[^A-Za-z0-9-]/g, "-")}.local`);
  }

  get text(): Buffer {
    return formatTxtDict(this.properties);
  }
}

/** Interface implemented by Zeroconf and test stubs. */
export interface ZeroconfLike {
  registerService(info: ServiceInfo): Promise<void> | void;
  unregisterService(info: ServiceInfo): Promise<void> | void;
  close(): void;
}

function srvData(info: ServiceInfo): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(0, 2);
  header.writeUInt16BE(info.port, 4);
  return Buffer.concat([header, qnameEncode(info.serverName)]);
}

/** Simple mDNS responder. */
export class Zeroconf implements ZeroconfLike {
  private readonly services = new Map<string, ServiceInfo>();
  private socket: dgram.Socket | null = null;
  private starting: Promise<void> | null = null;

  private async ensureStarted(): Promise<void> {
    if (this.socket) return;
    if (!this.starting) {
      this.starting = (async () => {
        const sock = await mcastSocket(null, MDNS_PORT);
        try {
          sock.addMembership(MDNS_ADDRESS);
        } catch (ex) {
          LOGGER.debug("Failed to join multicast group: %s", ex);
        }
        sock.on("message", (msg, rinfo) => this.handleMessage(msg, [rinfo.address, rinfo.port]));
        sock.on("error", (err) => LOGGER.debug("mDNS socket error: %s", err));
        this.socket = sock;
      })();
    }
    await this.starting;
  }

  private recordsFor(info: ServiceInfo, includePtr: boolean): DnsResource[] {
    const records: DnsResource[] = [];
    if (includePtr) {
      const ptr = qnameEncode(info.name);
      records.push(new DnsResource(info.type, QueryType.PTR, CLASS_IN, TTL, ptr.length, ptr));
    }
    const srv = srvData(info);
    records.push(new DnsResource(info.name, QueryType.SRV, CLASS_IN_UNIQUE, TTL, srv.length, srv));
    const txt = info.text;
    records.push(new DnsResource(info.name, QueryType.TXT, CLASS_IN_UNIQUE, TTL, txt.length, txt));
    for (const address of info.addresses) {
      const a = ipToBytes(address);
      records.push(new DnsResource(info.serverName, QueryType.A, CLASS_IN_UNIQUE, TTL, a.length, a));
    }
    return records;
  }

  private send(records: DnsResource[], target: [string, number] = [MDNS_ADDRESS, MDNS_PORT]): void {
    if (!this.socket || records.length === 0) return;
    const msg = new DnsMessage(0, 0x8400);
    // Records are put in the resources section (raw rd) since DnsMessage only packs
    // raw data for resources
    msg.resources.push(...records);
    const data = msg.pack();
    this.socket.send(data, target[1], target[0], (err) => {
      if (err) LOGGER.debug("Failed to send mDNS response: %s", err);
    });
  }

  private handleMessage(data: Buffer, addr: [string, number]): void {
    let msg: DnsMessage;
    try {
      msg = new DnsMessage().unpack(data);
    } catch {
      return;
    }
    if (msg.flags & 0x8000) return; // Ignore responses

    const answers: DnsResource[] = [];
    for (const question of msg.questions) {
      for (const info of this.services.values()) {
        const qname = question.qname.toLowerCase();
        if (qname === info.type.toLowerCase() && [QueryType.PTR, QueryType.ANY].includes(question.qtype)) {
          answers.push(...this.recordsFor(info, true));
        } else if (qname === info.name.toLowerCase()) {
          answers.push(...this.recordsFor(info, false));
        } else if (qname === info.serverName.toLowerCase()) {
          answers.push(...this.recordsFor(info, false).filter((r) => r.qtype === QueryType.A));
        }
      }
    }
    if (answers.length > 0) {
      // Unicast response requested (QU bit) or legacy query from other port
      const unicast = msg.questions.some((q) => q.qclass & 0x8000) || addr[1] !== MDNS_PORT;
      this.send(answers, unicast ? addr : undefined);
    }
  }

  async registerService(info: ServiceInfo): Promise<void> {
    await this.ensureStarted();
    this.services.set(info.name.toLowerCase(), info);
    LOGGER.debug("Registered service %s", info.name);
    // Announce service
    this.send(this.recordsFor(info, true));
  }

  async unregisterService(info: ServiceInfo): Promise<void> {
    this.services.delete(info.name.toLowerCase());
    LOGGER.debug("Unregistered service %s", info.name);
    // Send goodbye (TTL 0)
    this.send(
      this.recordsFor(info, true).map((r) => new DnsResource(r.qname, r.qtype, r.qclass, 0, r.rdLength, r.rd)),
    );
  }

  close(): void {
    this.services.clear();
    try {
      this.socket?.close();
    } catch {
      // Already closed
    }
    this.socket = null;
    this.starting = null;
  }
}
