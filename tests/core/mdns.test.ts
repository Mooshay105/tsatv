/** Unit tests for pyatv.core.mdns. */

import { expect, test } from "bun:test";
import * as mdns from "../../src/core/mdns.ts";
import * as dns from "../../src/support/dns.ts";
import * as fakeUdns from "../fake_udns.ts";
import * as dnsUtils from "../support/dns_utils.ts";

const SERVICE_NAME = "Kitchen";
const MEDIAREMOTE_SERVICE = "_mediaremotetv._tcp.local";

const TEST_SERVICES = Object.fromEntries([
  fakeUdns.mrpService(SERVICE_NAME, SERVICE_NAME, "mrp_id", { addresses: ["127.0.0.1"], port: 1234 }),
]);

function getResponseForService(service: string): [dns.DnsMessage, fakeUdns.FakeDnsService | undefined] {
  const req = mdns.createServiceQueries([service], dns.QueryType.PTR)[0]!;
  const resp = fakeUdns.createResponse(req, TEST_SERVICES);
  return [new dns.DnsMessage().unpack(resp.pack()), TEST_SERVICES[service]];
}

function parseServices(message: dns.DnsMessage): mdns.Service[] {
  const parser = new mdns.ServiceParser();
  parser.addMessage(message);
  return parser.parse();
}

test("non existing service", () => {
  const [resp] = getResponseForService("_missing");
  expect(resp.questions.length).toBe(2);
  expect(resp.answers.length).toBe(0);
  expect(resp.resources.length).toBe(0);
});

test("service has expected responses", () => {
  const [resp] = getResponseForService(MEDIAREMOTE_SERVICE);
  expect(resp.questions.length).toBe(2);
  expect(resp.answers.length).toBe(1);
  expect(resp.resources.length).toBe(3);
});

test("service has valid question", () => {
  const [resp] = getResponseForService(MEDIAREMOTE_SERVICE);
  const question = resp.questions[0]!;
  expect(question.qname).toBe(MEDIAREMOTE_SERVICE);
  expect(question.qtype).toBe(dns.QueryType.PTR);
  expect(question.qclass).toBe(0x8001);
});

test("service has valid answer", () => {
  const [resp, data] = getResponseForService(MEDIAREMOTE_SERVICE);
  const answer = resp.answers[0]!;
  expect(answer.qname).toBe(MEDIAREMOTE_SERVICE);
  expect(answer.qtype).toBe(dns.QueryType.PTR);
  expect(answer.qclass).toBe(dnsUtils.DEFAULT_QCLASS);
  expect(answer.ttl).toBe(dnsUtils.DEFAULT_TTL);
  expect(answer.rd).toBe(data!.name + "." + MEDIAREMOTE_SERVICE);
});

test("service has valid srv resource", () => {
  const [resp, data] = getResponseForService(MEDIAREMOTE_SERVICE);
  const srv = dnsUtils.getQtype(resp.resources, dns.QueryType.SRV)!;
  expect(srv.qname).toBe(data!.name + "." + MEDIAREMOTE_SERVICE);
  expect(srv.qtype).toBe(dns.QueryType.SRV);
  expect(srv.qclass).toBe(dnsUtils.DEFAULT_QCLASS);
  expect(srv.ttl).toBe(dnsUtils.DEFAULT_TTL);
  expect(srv.rd).toEqual({ priority: 0, weight: 0, port: data!.port, target: data!.name + ".local" });
});

test("service has valid txt resource", () => {
  const [resp, data] = getResponseForService(MEDIAREMOTE_SERVICE);
  const srv = dnsUtils.getQtype(resp.resources, dns.QueryType.TXT)!;
  expect(srv.qname).toBe(data!.name + "." + MEDIAREMOTE_SERVICE);
  expect(srv.qtype).toBe(dns.QueryType.TXT);
  expect(srv.qclass).toBe(dnsUtils.DEFAULT_QCLASS);
  expect(srv.ttl).toBe(dnsUtils.DEFAULT_TTL);
  const rd = srv.rd as Map<string, Buffer>;
  expect(rd.size).toBe(Object.keys(data!.properties).length);
  for (const [k, v] of Object.entries(data!.properties)) expect(rd.get(k)).toEqual(v);
});

test("service has valid a resource", () => {
  const [resp, data] = getResponseForService(MEDIAREMOTE_SERVICE);
  const srv = dnsUtils.getQtype(resp.resources, dns.QueryType.A)!;
  expect(srv.qname).toBe(data!.name + ".local");
  expect(srv.qtype).toBe(dns.QueryType.A);
  expect(srv.qclass).toBe(dnsUtils.DEFAULT_QCLASS);
  expect(srv.ttl).toBe(dnsUtils.DEFAULT_TTL);
  expect(srv.rd).toBe("127.0.0.1");
});

test("authority", () => {
  const msg = new dns.DnsMessage();
  msg.authorities.push(dnsUtils.resource("test.local", dns.QueryType.A, Buffer.from([1, 2, 3, 4])));
  const unpacked = new dns.DnsMessage().unpack(msg.pack());
  expect(unpacked.authorities.length).toBe(1);
  const record = unpacked.authorities[0]!;
  expect(record.qname).toBe("test.local");
  expect(record.qtype).toBe(dns.QueryType.A);
  expect(record.qclass).toBe(dnsUtils.DEFAULT_QCLASS);
  expect(record.ttl).toBe(dnsUtils.DEFAULT_TTL);
  expect(record.rd).toBe("1.2.3.4");
});

test("parse empty service", () => {
  expect(parseServices(new dns.DnsMessage())).toEqual([]);
});

test("parse no service type", () => {
  const message = dnsUtils.addService(new dns.DnsMessage(), null, "service", [], 0, {});
  expect(parseServices(message).length).toBe(0);
});

test("parse no service name", () => {
  const message = dnsUtils.addService(new dns.DnsMessage(), "_abc._tcp.local", null, [], 0, {});
  expect(parseServices(message).length).toBe(0);
});

test("parse with name and type", () => {
  const parsed = parseServices(dnsUtils.addService(new dns.DnsMessage(), "_abc._tcp.local", "service", [], 0, {}));
  expect(parsed.length).toBe(1);
  dnsUtils.assertService(parsed[0]!, "_abc._tcp.local", "service", [], 0, {});
});

test("parse with port and address", () => {
  const params = ["_abc._tcp.local", "service", ["10.0.0.1"], 123, {}] as const;
  const parsed = parseServices(dnsUtils.addService(new dns.DnsMessage(), params[0], params[1], [...params[2]], params[3], params[4]));
  expect(parsed.length).toBe(1);
  dnsUtils.assertService(parsed[0]!, params[0], params[1], [...params[2]], params[3], params[4]);
});

test("parse single service", () => {
  const parsed = parseServices(dnsUtils.addService(new dns.DnsMessage(), "_abc._tcp.local", "service", ["10.0.10.1"], 123, { foo: "bar" }));
  expect(parsed.length).toBe(1);
  dnsUtils.assertService(parsed[0]!, "_abc._tcp.local", "service", ["10.0.10.1"], 123, { foo: "bar" });
});

test("parse double service", () => {
  let message = dnsUtils.addService(new dns.DnsMessage(), "_abc._tcp.local", "service1", ["10.0.10.1"], 123, { foo: "bar" });
  message = dnsUtils.addService(message, "_def._tcp.local", "service2", ["10.0.10.2"], 456, { fizz: "buzz" });
  const parsed = parseServices(message);
  expect(parsed.length).toBe(2);
  dnsUtils.assertService(parsed[0]!, "_abc._tcp.local", "service1", ["10.0.10.1"], 123, { foo: "bar" });
  dnsUtils.assertService(parsed[1]!, "_def._tcp.local", "service2", ["10.0.10.2"], 456, { fizz: "buzz" });
});

test("parse pick one available address", () => {
  const addresses = ["10.0.10.1", "10.0.10.2"];
  const parsed = parseServices(dnsUtils.addService(new dns.DnsMessage(), "_abc._tcp.local", "service", addresses, 123, { foo: "bar" }));
  expect(parsed.length).toBe(1);
  expect(addresses).toContain(parsed[0]!.address!);
});

test("parse ignore link local address", () => {
  const parsed = parseServices(dnsUtils.addService(new dns.DnsMessage(), "_abc._tcp.local", "service", ["169.254.1.1"], 123, { foo: "bar" }));
  expect(parsed.length).toBe(1);
  expect(parsed[0]!.address).toBeNull();
});

test("parse properties converts keys to lower case", () => {
  const parsed = parseServices(dnsUtils.addService(new dns.DnsMessage(), "_abc._tcp.local", "service", [], 0, { FOO: "bar", Bar: "FOO" }));
  expect(parsed.length).toBe(1);
  expect(mdns.getProperty(parsed[0]!.properties, "foo")).toBe("bar");
  expect(mdns.getProperty(parsed[0]!.properties, "Bar")).toBe("FOO");
});

test("parse ignore duplicate records", () => {
  const message = dnsUtils.addService(new dns.DnsMessage(), "_abc._tcp.local", "service", [], 0, {});
  const parser = new mdns.ServiceParser();
  parser.addMessage(message);
  parser.addMessage(message);
  expect(parser.table.size).toBe(1);
  const records = parser.table.get("service._abc._tcp.local")!;
  expect(records.has(dns.QueryType.SRV)).toBe(true);
  expect(records.get(dns.QueryType.SRV)!.length).toBe(1);
});
