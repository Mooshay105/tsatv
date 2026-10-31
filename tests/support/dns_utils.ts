/** Helper methods for DNS message. */

import { expect } from "bun:test";
import type { Service } from "../../src/core/mdns.ts";
import { type DnsMessage, DnsResource, QueryType } from "../../src/support/dns.ts";

export const DEFAULT_QCLASS = 1;
export const DEFAULT_TTL = 10;

export function answer(qname: string, fullName: string): DnsResource {
  return new DnsResource(qname, QueryType.PTR, DEFAULT_QCLASS, DEFAULT_TTL, 0, fullName);
}

export function resource(qname: string, qtype: QueryType, rd: any): DnsResource {
  const length = rd instanceof Uint8Array ? rd.length : typeof rd === "string" ? rd.length : 0;
  return new DnsResource(qname, qtype, DEFAULT_QCLASS, DEFAULT_TTL, length, rd);
}

export function properties(props: Record<string, Buffer>): Buffer {
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(props)) {
    const encoded = Buffer.concat([Buffer.from(k, "ascii"), Buffer.from("="), v]);
    parts.push(Buffer.from([encoded.length]), encoded);
  }
  return Buffer.concat(parts);
}

export function getQtype(messages: DnsResource[], qtype: number): DnsResource | null {
  return messages.find((m) => m.qtype === qtype) ?? null;
}

export function addService(
  message: DnsMessage,
  serviceType: string | null,
  serviceName: string | null,
  addresses: string[],
  port: number,
  props: Record<string, string>,
): DnsMessage {
  if (serviceName === null) return message;

  for (const address of addresses) {
    message.resources.push(resource(serviceName + ".local", QueryType.A, address));
  }

  // Remaining depends on service type
  if (serviceType === null) return message;

  message.answers.push(answer(serviceType, serviceName + "." + serviceType));

  message.resources.push(
    resource(serviceName + "." + serviceType, QueryType.SRV, {
      priority: 0,
      weight: 0,
      port,
      target: serviceName + ".local",
    }),
  );

  if (Object.keys(props).length > 0) {
    message.resources.push(
      resource(
        serviceName + "." + serviceType,
        QueryType.TXT,
        new Map(Object.entries(props).map(([k, v]) => [k, Buffer.from(v, "utf-8")])),
      ),
    );
  }

  return message;
}

export function assertService(
  message: Service,
  serviceType: string,
  serviceName: string,
  addresses: string[],
  port: number,
  knownProperties: Record<string, string>,
): void {
  expect(message.type).toBe(serviceType);
  expect(message.name).toBe(serviceName);
  // Assume first address (if multiple) is expected
  expect(message.address).toBe(addresses.length > 0 ? addresses[0]! : null);
  expect(message.port).toBe(port);
  const props = message.properties instanceof Map ? Object.fromEntries(message.properties) : message.properties;
  expect(props).toEqual(knownProperties);
}
