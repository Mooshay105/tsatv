/** Fake unicast DNS server used for testing scanning. */

import { spyOn } from "bun:test";
import * as mdns from "../src/core/mdns.ts";
import * as dns from "../src/support/dns.ts";
import { ipToBytes } from "../src/support/ip.ts";
import { getLogger } from "../src/support/logging.ts";
import { createDatagramEndpoint, type Address, type DatagramProtocol, type DatagramTransport } from "../src/support/transport.ts";
import * as dnsUtils from "./support/dns_utils.ts";

const LOGGER = getLogger("tests.fake_udns");

/** Representation of fake DNS service. */
export interface FakeDnsService {
  name: string;
  addresses: string[];
  port: number;
  properties: Record<string, Buffer>;
  model: string | null;
}

const enc = (s: string) => Buffer.from(s, "utf-8");

export function mrpService(
  serviceName: string,
  atvName: string,
  identifier: string,
  options: { addresses?: string[]; port?: number; model?: string | null; version?: string } = {},
): [string, FakeDnsService] {
  return [
    "_mediaremotetv._tcp.local",
    {
      name: serviceName,
      addresses: options.addresses ?? ["127.0.0.1"],
      port: options.port ?? 49152,
      properties: {
        Name: enc(atvName),
        UniqueIdentifier: enc(identifier),
        SystemBuildVersion: enc(options.version ?? "18M60"),
      },
      model: options.model ?? null,
    },
  ];
}

export function airplayService(
  atvName: string,
  deviceid: string,
  options: { addresses?: string[]; port?: number; model?: string | null } = {},
): [string, FakeDnsService] {
  const properties: Record<string, Buffer> = { deviceid: enc(deviceid), features: enc("0x1") };
  if (options.model) {
    properties.model = enc(options.model);
    properties.flags = enc("0x8"); // Pin required
  }
  return [
    "_airplay._tcp.local",
    {
      name: atvName,
      addresses: options.addresses ?? ["127.0.0.1"],
      port: options.port ?? 7000,
      properties,
      model: options.model ?? null,
    },
  ];
}

export function homesharingService(
  serviceName: string,
  atvName: string,
  hsgid: string,
  options: { addresses?: string[]; model?: string | null } = {},
): [string, FakeDnsService] {
  return [
    "_appletv-v2._tcp.local",
    {
      name: serviceName,
      addresses: options.addresses ?? ["127.0.0.1"],
      port: 3689,
      properties: { hG: enc(hsgid), Name: enc(atvName) },
      model: options.model ?? null,
    },
  ];
}

export function deviceService(
  serviceName: string,
  atvName: string,
  options: { addresses?: string[]; model?: string | null } = {},
): [string, FakeDnsService] {
  return [
    "_touch-able._tcp.local",
    {
      name: serviceName,
      addresses: options.addresses ?? ["127.0.0.1"],
      port: 3689,
      properties: { CtlN: enc(atvName) },
      model: options.model ?? null,
    },
  ];
}

export function companionService(
  serviceName: string,
  options: { addresses?: string[]; port?: number; model?: string | null } = {},
): [string, FakeDnsService] {
  return [
    "_companion-link._tcp.local",
    {
      name: serviceName,
      addresses: options.addresses ?? ["127.0.0.1"],
      port: options.port ?? 0,
      properties: { rpHA: enc("33efedd528a") },
      model: options.model ?? null,
    },
  ];
}

export function raopService(
  name: string,
  identifier: string,
  options: { addresses?: string[]; port?: number; model?: string | null } = {},
): [string, FakeDnsService] {
  return [
    "_raop._tcp.local",
    {
      name: identifier + "@" + name,
      addresses: options.addresses ?? ["127.0.0.1"],
      port: options.port ?? 0,
      properties: {},
      model: options.model ?? null,
    },
  ];
}

export function hscpService(
  name: string,
  identifier: string,
  hsgid: string,
  options: { addresses?: string[]; port?: number; model?: string | null } = {},
): [string, FakeDnsService] {
  return [
    "_hscp._tcp.local",
    {
      name: "HSCP Name",
      addresses: options.addresses ?? ["127.0.0.1"],
      port: options.port ?? 0,
      properties: { "Machine Name": enc(name), "Machine ID": enc(identifier), hG: enc(hsgid) },
      model: options.model ?? null,
    },
  ];
}

function lookupService(
  question: dns.DnsQuestion,
  services: Record<string, FakeDnsService>,
): [FakeDnsService | null, string | null] {
  if (question.qname.startsWith("_")) {
    const service = services[question.qname];
    if (service) return [service, service.name + "." + question.qname];
    return [null, null];
  }

  const idx = question.qname.indexOf(".");
  const serviceName = idx === -1 ? question.qname : question.qname.slice(0, idx);
  const serviceType = idx === -1 ? "" : question.qname.slice(idx + 1);
  for (const [name, service] of Object.entries(services)) {
    if (serviceType === name && serviceName === service.name) return [service, question.qname];
  }
  return [null, null];
}

export function createResponse(
  request: Uint8Array,
  services: Record<string, FakeDnsService>,
  ipFilter: string | null = null,
  sleepProxy = false,
): dns.DnsMessage {
  const msg = new dns.DnsMessage().unpack(request);

  const resp = new dns.DnsMessage();
  resp.flags = 0x0840;
  resp.questions = msg.questions;

  for (const question of resp.questions) {
    const [service, fullName] = lookupService(question, services);
    if (service === null || (ipFilter && !service.addresses.includes(ipFilter))) continue;

    // Add answer
    if (fullName) {
      resp.answers.push(dnsUtils.answer(question.qname, fullName));

      // If acting as sleep proxy, just return a PTR
      if (sleepProxy && question.qname.startsWith("_")) continue;
    }

    // Add service (SRV) resource
    if (service.port) {
      const localName = dns.qnameEncode(service.name + ".local");
      const rd = Buffer.concat([Buffer.from([0, 0, 0, 0, service.port >> 8, service.port & 0xff]), localName]);
      resp.resources.push(dnsUtils.resource(fullName!, dns.QueryType.SRV, rd));
    }

    // Add IP address(es)
    for (const address of service.addresses) {
      resp.resources.push(dnsUtils.resource(service.name + ".local", dns.QueryType.A, ipToBytes(address)));
    }

    // Add properties
    if (Object.keys(service.properties).length > 0) {
      resp.resources.push(dnsUtils.resource(fullName!, dns.QueryType.TXT, dnsUtils.properties(service.properties)));
    }

    // Add model if present
    if (service.model) {
      const rd = dnsUtils.properties({ model: enc(service.model) });
      resp.resources.push(dnsUtils.resource(service.name + "._device-info._tcp.local", dns.QueryType.TXT, rd));
    }
  }

  return resp;
}

export class FakeUdns implements DatagramProtocol {
  server: DatagramTransport | null = null;
  transport: DatagramTransport | null = null;
  services: Record<string, FakeDnsService>;
  skipCount = 0; // Ignore sending response to this many requests
  ipFilter: string | null = null;
  sleepProxy = false;
  requestCount = 0;

  constructor(services?: Record<string, FakeDnsService>) {
    this.services = services ?? {};
  }

  async start(): Promise<void> {
    [this.server] = await createDatagramEndpoint(() => this, { localAddr: ["127.0.0.1", 0] });
    LOGGER.debug("Starting fake UDNS server at port %d", this.port);
  }

  close(): void {
    this.server?.close();
  }

  addService(service: [string, FakeDnsService]): void {
    this.services[service[0]] = service[1];
  }

  get port(): number {
    return this.server!.getExtraInfo("sockname")[1];
  }

  connectionMade(transport: DatagramTransport): void {
    this.transport = transport;
  }

  datagramReceived(data: Buffer, addr: Address): void {
    const msg = new dns.DnsMessage().unpack(data);
    LOGGER.debug("Received DNS request %s: %s", addr, msg);

    if (this.skipCount > 0) {
      LOGGER.debug("Not sending DNS response (%d)", this.skipCount);
      this.skipCount -= 1;
      return;
    }

    const resp = createResponse(data, this.services, this.ipFilter, this.sleepProxy);
    this.transport!.sendto(resp.pack(), addr);
    this.requestCount += 1;
  }

  errorReceived(exc: Error): void {
    LOGGER.error("Got an error: %s", exc);
  }
}

/** Stub multicast so that it uses unicast against the fake server instead. */
export function stubMulticast(udnsServer: FakeUdns): { mockRestore(): void } {
  return spyOn(mdns, "multicast").mockImplementation(async (services: string[]) => {
    const hosts = new Set(Object.values(udnsServer.services).flatMap((service) => service.addresses));
    const devices: mdns.Response[] = [];
    const sleepProxy = udnsServer.sleepProxy;
    udnsServer.sleepProxy = false;
    for (const host of hosts) {
      udnsServer.ipFilter = host;
      const response = await mdns.unicast("127.0.0.1", services, udnsServer.port);
      devices.push({ services: response.services, deepSleep: sleepProxy, model: response.model });
    }
    return devices;
  });
}
