/** Minimalistic DNS-SD implementation. */

import type dgram from "node:dgram";
import { InvalidConfigError } from "../exceptions.ts";
import { ServiceInfo, type ZeroconfLike } from "../support/zeroconf.ts";
import { CancelledError, createTask, sleep, type Task, TimeoutError, waitFor } from "../support/asyncio.ts";
import { CaseInsensitiveDict } from "../support/collections.ts";
import { DnsMessage, DnsQuestion, type DnsResource, QueryType, ServiceInstanceName } from "../support/dns.ts";
import { logBinary } from "../support/index.ts";
import { isLinkLocal, isLoopback } from "../support/ip.ts";
import { getLogger, type LogLevel } from "../support/logging.ts";
import * as net from "../support/net.ts";
import {
  type Address,
  createDatagramEndpoint,
  type DatagramProtocol,
  type DatagramTransport,
} from "../support/transport.ts";

const LOGGER = getLogger("pyatv.core.mdns");

// Number of services to include in each request
export const SERVICES_PER_MSG = 3;

export const SLEEP_PROXY_SERVICE = "_sleep-proxy._udp.local";

// This module produces a lot of debug output, use a dedicated log level.
export const TRAFFIC_LEVEL = 5 as LogLevel;

export const DEVICE_INFO_SERVICE = "_device-info._tcp.local";

/** Represent an MDNS service. */
export interface Service {
  type: string;
  name: string;
  address: string | null;
  port: number;
  properties: CaseInsensitiveDict<string> | Record<string, string>;
}

/** Represent response to an MDNS request. */
export interface Response {
  services: Service[];
  deepSleep: boolean;
  model: string | null; // Comes from _device-info._tcp.local
}

/** Get a property from service properties (Map or plain object). */
export function getProperty(properties: Service["properties"], key: string): string | undefined {
  if (properties instanceof Map) return properties.get(key);
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(properties)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

/**
 * Decode a bytes value and convert non-breaking-spaces.
 *
 * (0xC2A0, 0x00A0) are converted to spaces before decoding.
 */
export function decodeValue(value: Uint8Array): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const b = value[i]!;
    const nextB = value[i + 1];
    if ((b === 0xc2 || b === 0x00) && nextB === 0xa0) {
      bytes.push(0x20);
      i++;
    } else {
      bytes.push(b);
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(bytes));
  } catch {
    return Buffer.from(value).toString("latin1");
  }
}

function decodeProperties(properties: Map<string, Buffer> | Record<string, Buffer>): CaseInsensitiveDict<string> {
  const entries = properties instanceof Map ? [...properties.entries()] : Object.entries(properties);
  return new CaseInsensitiveDict(entries.map(([k, v]) => [k, decodeValue(v)] as [string, string]));
}

/** Create service request messages. */
export function createServiceQueries(services: string[], qtype: QueryType): Buffer[] {
  const queries: Buffer[] = [];
  for (let i = 0; i < Math.ceil(services.length / SERVICES_PER_MSG); i++) {
    const serviceChunk = services.slice(i * SERVICES_PER_MSG, i * SERVICES_PER_MSG + 4);
    const msg = new DnsMessage(0x35ff);
    msg.questions.push(...serviceChunk.map((s) => new DnsQuestion(s, qtype, 0x8001)));
    msg.questions.push(new DnsQuestion(SLEEP_PROXY_SERVICE, qtype, 0x8001));
    queries.push(msg.pack());
  }
  return queries;
}

function getModel(services: Service[]): string | null {
  for (const service of services) {
    if (service.type === DEVICE_INFO_SERVICE) return getProperty(service.properties, "model") ?? null;
  }
  return null;
}

function firstRd(qtype: QueryType, entries: Map<number, DnsResource[]>): any {
  const list = entries.get(qtype);
  return list && list.length > 0 ? list[0]!.rd : null;
}

function resourceKey(record: DnsResource): string {
  const rd = record.rd;
  let rdKey: string;
  if (rd instanceof Uint8Array) rdKey = Buffer.from(rd).toString("hex");
  else if (rd instanceof Map) rdKey = JSON.stringify([...rd.entries()].map(([k, v]) => [k, Buffer.from(v).toString("hex")]));
  else rdKey = JSON.stringify(rd);
  return `${record.qname}|${record.qtype}|${record.qclass}|${record.ttl}|${rdKey}`;
}

/** Parse zeroconf services from records in DNS messages. */
export class ServiceParser {
  readonly table = new Map<string, Map<number, DnsResource[]>>();
  readonly ptrs = new Map<string, string>(); // qname -> real name
  private _seen = new Set<string>();
  private _cache: Service[] | null = null;

  /** Add message with records to parse. */
  addMessage(message: DnsMessage): this {
    this._cache = null;
    for (const record of [...message.answers, ...message.resources]) {
      if (record.qtype === QueryType.PTR && record.qname.startsWith("_")) {
        this.ptrs.set(record.qname, record.rd);
      } else {
        let entry = this.table.get(record.qname);
        if (!entry) {
          entry = new Map();
          this.table.set(record.qname, entry);
        }
        let list = entry.get(record.qtype);
        if (!list) {
          list = [];
          entry.set(record.qtype, list);
        }
        const key = resourceKey(record);
        if (!this._seen.has(key)) {
          this._seen.add(key);
          list.push(record);
        }
      }
    }
    return this;
  }

  /** Parse records and return services. */
  parse(): Service[] {
    if (this._cache && this._cache.length > 0) return this._cache;

    const results = new Map<string, Service>();

    // Build services
    for (const [service, device] of this.table) {
      let serviceName: ServiceInstanceName;
      try {
        serviceName = ServiceInstanceName.splitName(service);
      } catch {
        continue;
      }

      const srvRd = firstRd(QueryType.SRV, device);
      const target = srvRd ? srvRd.target : null;

      const targetRecords = (target ? this.table.get(target)?.get(QueryType.A) : undefined) ?? [];
      let address: string | null = null;

      // Pick one address that is not link-local
      for (const record of targetRecords) {
        if (!isLinkLocal(record.rd)) {
          address = record.rd;
          break;
        }
      }

      results.set(service, {
        type: serviceName.ptrName,
        name: serviceName.instance as string,
        address,
        port: srvRd ? srvRd.port : 0,
        properties: decodeProperties(firstRd(QueryType.TXT, device) ?? new Map()),
      });
    }

    // If there are PTRs to unknown services, create placeholders
    for (const [qname, realName] of this.ptrs) {
      if (!results.has(realName)) {
        results.set(realName, {
          type: qname,
          name: realName.split(".")[0]!,
          address: null,
          port: 0,
          properties: new CaseInsensitiveDict<string>(),
        });
      }
    }
    this._cache = [...results.values()];
    return this._cache;
  }
}

interface QueryResponse {
  count: number;
  deepSleep: boolean;
  parser: ServiceParser;
}

/** Simple one-shot signal (asyncio.Semaphore(0) usage). */
export class Signal {
  private released = false;
  private waiters: Array<() => void> = [];

  release(): void {
    this.released = true;
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((w) => w());
  }

  acquire(): Promise<void> {
    if (this.released) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

/** Protocol to make unicast requests. */
export class UnicastDnsSdClientProtocol implements DatagramProtocol {
  readonly queries: Buffer[];
  transport: DatagramTransport | null = null;
  readonly parser = new ServiceParser();
  private readonly semaphore = new Signal();
  receivedResponses = 0;
  private _task: Task<void> | null = null;

  constructor(
    services: string[],
    readonly host: string,
    readonly timeout: number,
  ) {
    this.queries = createServiceQueries(services, QueryType.PTR);
  }

  /** Get response with a maximum timeout. */
  async getResponse(): Promise<Response> {
    try {
      await waitFor(this.semaphore.acquire(), this.timeout);
    } finally {
      this._finished();
    }
    if (this._task) {
      try {
        await this._task.promise;
      } catch (ex) {
        if (!(ex instanceof CancelledError)) throw ex;
      }
    }

    const services = this.parser.parse();
    return { services, deepSleep: false, model: getModel(services) };
  }

  connectionMade(transport: DatagramTransport): void {
    this.transport = transport;
    this._task = createTask((signal) => this._resendLoop(signal));
  }

  private async _resendLoop(signal: AbortSignal): Promise<void> {
    for (let i = 0; i < Math.ceil(this.timeout); i++) {
      if (signal.aborted) return;
      for (const query of this.queries) {
        logBinary(LOGGER, "Sending DNS request to " + this.host, { Data: query }, TRAFFIC_LEVEL);
        this.transport?.sendto(query);
      }
      await sleep(1);
    }
  }

  datagramReceived(data: Buffer, _addr: Address): void {
    logBinary(
      LOGGER,
      "Received DNS response from " + this.host,
      { Data: data, Index: this.receivedResponses + 1, Total: this.queries.length },
      TRAFFIC_LEVEL,
    );

    this.parser.addMessage(new DnsMessage().unpack(data));
    this.receivedResponses += 1;

    if (this.receivedResponses === this.queries.length) {
      this._finished();
      this.transport?.close();
    }
  }

  errorReceived(exc: Error): void {
    LOGGER.debug("Error during DNS lookup for %s: %s", this.host, exc);
    this._finished();
  }

  connectionLost(_exc: Error | null): void {
    this._finished();
  }

  private _finished(): void {
    this.semaphore.release();
    this._task?.cancel();
  }
}

/** Delegate incoming data to another object. */
export class ReceiveDelegate implements DatagramProtocol {
  transport: DatagramTransport | null = null;
  isLoopback = false;
  private readonly delegate: WeakRef<MulticastDnsSdClientProtocol>;

  constructor(delegate: MulticastDnsSdClientProtocol) {
    this.delegate = new WeakRef(delegate);
  }

  /** Send message to a target. */
  sendto(message: Uint8Array, target: Address): void {
    if (!this.isLoopback) this.transport?.sendto(message, target);
  }

  /** Close underlying socket. */
  close(): void {
    this.transport?.close();
  }

  connectionMade(transport: DatagramTransport): void {
    this.transport = transport;
    // Determine if this is a loopback socket (don't send to those)
    const [address] = transport.getExtraInfo("sockname");
    this.isLoopback = mdnsHooks.isLoopback(address);
  }

  datagramReceived(data: Buffer, addr: Address): void {
    const delegate = this.delegate.deref();
    if (delegate) {
      try {
        delegate.datagramReceived(data, addr);
      } catch (ex) {
        LOGGER.error("exception during data handling: %s", ex);
      }
    }
  }

  errorReceived(exc: Error): void {
    const delegate = this.delegate.deref();
    if (delegate) {
      try {
        delegate.errorReceived(exc);
      } catch (ex) {
        LOGGER.error("connection error: %s", ex);
      }
    }
  }

  toString(): string {
    return String(this.transport?.getExtraInfo("sockname"));
  }
}

/** Hooks that can be replaced in tests. */
export const mdnsHooks = {
  /** Called with the protocol instance created by multicast (used by tests). */
  onMulticastProtocol: (_protocol: MulticastDnsSdClientProtocol): void => undefined,
  isLoopback: (address: string): boolean => {
    try {
      return isLoopback(address);
    } catch {
      return false;
    }
  },
};

/** Protocol to make multicast requests. */
export class MulticastDnsSdClientProtocol {
  readonly queries: Buffer[];
  queryResponses = new Map<string, QueryResponse>();
  readonly endCondition: (response: Response) => boolean;
  readonly semaphore = new Signal();
  private readonly _unicasts = new Map<string, Buffer[]>();
  private _task: Task<void> | null = null;
  private readonly _receivers: ReceiveDelegate[] = [];

  constructor(
    readonly services: string[],
    readonly address: string,
    readonly port: number,
    endCondition: ((response: Response) => boolean) | null,
  ) {
    this.queries = createServiceQueries(services, QueryType.PTR);
    this.endCondition = endCondition ?? (() => false);
  }

  /** Add a new multicast socket. */
  async addSocket(sock: dgram.Socket): Promise<void> {
    const [, protocol] = await createDatagramEndpoint(() => new ReceiveDelegate(this), { sock });
    this._receivers.push(protocol);
  }

  /** Get response with a maximum timeout. */
  async getResponse(timeout: number): Promise<Response[]> {
    // Semaphore used here as a quick-bailout when testing
    try {
      this._task = createTask((signal) => this._resendLoop(timeout, signal));
      await waitFor(this.semaphore.acquire(), timeout);
    } catch (ex) {
      if (!(ex instanceof TimeoutError)) throw ex;
    } finally {
      this.close();
      if (this._task) {
        try {
          await this._task.promise;
        } catch (ex) {
          if (!(ex instanceof CancelledError)) throw ex;
        }
        this._task = null;
      }
    }

    return [...this.queryResponses.values()].map((queryResponse) => {
      const services = queryResponse.parser.parse();
      return { services, deepSleep: queryResponse.deepSleep, model: getModel(services) };
    });
  }

  private async _resendLoop(timeout: number, signal: AbortSignal): Promise<void> {
    for (let i = 0; i < Math.ceil(timeout); i++) {
      if (signal.aborted) return;
      for (const query of this.queries) {
        logBinary(LOGGER, `Sending multicast DNS request to ${this.address}:${this.port}`, { Data: query }, TRAFFIC_LEVEL);
        this._sendto(query, [this.address, this.port]);
      }

      // Send unicast requests if devices are sleeping
      for (const [address, queries] of this._unicasts) {
        for (const query of queries) {
          logBinary(LOGGER, `Sending unicast DNS request to ${address}:${this.port}`, { Data: query }, TRAFFIC_LEVEL);
          this._sendto(query, [address, this.port]);
        }
      }

      await sleep(1);
    }
  }

  private _sendto(message: Uint8Array, target: Address): void {
    for (const receiver of this._receivers) {
      try {
        receiver.sendto(message, target);
      } catch (ex) {
        LOGGER.error("fail to send to %s: %s", receiver, ex);
      }
    }
  }

  datagramReceived(data: Buffer, addr: Address): void {
    logBinary(LOGGER, `Received DNS response from ${addr}`, { Data: data }, TRAFFIC_LEVEL);

    let queryResp = this.queryResponses.get(addr[0]);
    if (!queryResp) {
      queryResp = { count: 0, deepSleep: false, parser: new ServiceParser() };
      this.queryResponses.set(addr[0], queryResp);
    }

    // Suppress decode errors for now (but still log)
    let decodedMsg: DnsMessage;
    let services: Service[];
    try {
      decodedMsg = new DnsMessage().unpack(data);
      services = new ServiceParser().addMessage(decodedMsg).parse();
    } catch {
      logBinary(LOGGER, "Failed to decode message", { Msg: data });
      return;
    }

    if (services.length === 0) return;

    // Ignore responses from other services
    for (const service of services) {
      if (!(this.services.includes(service.type) || [DEVICE_INFO_SERVICE, SLEEP_PROXY_SERVICE].includes(service.type))) {
        return;
      }
    }

    const isSleepProxy = services.every((service) => service.port === 0);
    queryResp.count += 1;
    queryResp.deepSleep ||= isSleepProxy;
    queryResp.parser.addMessage(decodedMsg);

    if (isSleepProxy) {
      this._unicasts.set(
        addr[0],
        createServiceQueries(
          services.map((service) => service.name + "." + service.type),
          QueryType.ANY,
        ),
      );
    } else if (queryResp.count >= this.queries.length) {
      const parsed = queryResp.parser.parse();
      const response: Response = { services: parsed, deepSleep: queryResp.deepSleep, model: getModel(parsed) };

      if (this.endCondition(response)) {
        // Matches end condition: replace everything found so far and abort
        this.queryResponses = new Map([[addr[0], queryResp]]);
        this.semaphore.release();
        this.close();
      }
    }
  }

  errorReceived(exc: Error): void {
    LOGGER.debug("Error during MDNS lookup: %s", exc);
  }

  /** Close resources used by this instance. */
  close(): void {
    for (const receiver of this._receivers) receiver.close();
    this._task?.cancel();
  }
}

/** Send request for services to a host. */
export async function unicast(address: string, services: string[], port = 5353, timeout = 4): Promise<Response> {
  const [transport, protocol] = await createDatagramEndpoint(
    () => new UnicastDnsSdClientProtocol(services, address, timeout),
    { remoteAddr: [address, port] },
  );
  try {
    return await protocol.getResponse();
  } finally {
    transport.close();
  }
}

/** Send multicast request for services. */
export async function multicast(
  services: string[],
  options: {
    address?: string;
    port?: number;
    timeout?: number;
    endCondition?: ((response: Response) => boolean) | null;
  } = {},
): Promise<Response[]> {
  const address = options.address ?? "224.0.0.251";
  const port = options.port ?? 5353;
  const protocol = new MulticastDnsSdClientProtocol(services, address, port, options.endCondition ?? null);
  mdnsHooks.onMulticastProtocol(protocol);

  // Socket listening on 5353 from anywhere
  try {
    await protocol.addSocket(await net.mcastSocket(null, 5353));
  } catch (ex) {
    LOGGER.debug("Failed to listen on port 5353 (ignoring): %s", ex);
  }

  // One socket per local IP address
  for (const addr of net.getPrivateAddresses()) {
    try {
      await protocol.addSocket(await net.mcastSocket(addr));
    } catch {
      LOGGER.debug("Failed to add listener for %s (ignoring)", addr);
    }
  }

  return protocol.getResponse(options.timeout ?? 4);
}

/** Publish an MDNS service on the network. Returns a function that unregisters it. */
export async function publish(service: Service, zconf: ZeroconfLike): Promise<() => Promise<void>> {
  if (service.address === null) {
    throw new InvalidConfigError(`no address for ${service.name}.${service.type}`);
  }
  const properties =
    service.properties instanceof Map ? Object.fromEntries(service.properties.entries()) : { ...service.properties };
  const zsrv = new ServiceInfo(
    `${service.type}.`,
    `${service.name}.${service.type}.`,
    [service.address],
    service.port,
    properties,
  );

  LOGGER.debug("Publishing zeroconf service: %s", zsrv.name);
  await zconf.registerService(zsrv);

  return async () => {
    LOGGER.debug("Unregistering service %s", zsrv.name);
    await zconf.unregisterService(zsrv);
  };
}
