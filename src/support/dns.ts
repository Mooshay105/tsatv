/** Processing functions for raw DNS messages. */

import { domainToUnicode } from "node:url";
import { BytesReader, pack } from "./bytes.ts";
import { CaseInsensitiveDict } from "./collections.ts";
import { ipFromBytes } from "./ip.ts";
import { getLogger } from "./logging.ts";

const LOGGER = getLogger("pyatv.support.dns");

/**
 * Represents either a service or service instance name in the DNS.
 *
 * The special thing this class can do is (attempt) to handle periods in the instance
 * name correctly.
 */
export class ServiceInstanceName {
  constructor(
    readonly instance: string | null,
    readonly service: string,
    readonly domain: string = "local",
  ) {}

  /** Join all components together with periods. */
  toString(): string {
    return [this.instance, this.service, this.domain].filter((x) => x).join(".");
  }

  toTuple(): [string | null, string, string] {
    return [this.instance, this.service, this.domain];
  }

  /**
   * Split a name into instance (optional), service, and domain parts.
   *
   * If the name given isn't a service name or service instance name, this method
   * raise an error.
   */
  static splitName(name: string): ServiceInstanceName {
    const labels = name.split(".");
    if (labels.length < 2) {
      throw new RangeError("There must be at least three labels in a service name");
    }
    for (let index = 0; index < labels.length - 1; index++) {
      const label = labels[index]!;
      const nextLabel = labels[index + 1]!;
      if (label.startsWith("_") && ["_tcp", "_udp"].includes(nextLabel.toLowerCase())) {
        return new ServiceInstanceName(
          labels.slice(0, index).join(".") || null,
          label + "." + nextLabel,
          labels.slice(index + 2).join("."),
        );
      }
    }
    throw new RangeError(`'${name}' is not a service domain, nor a service instance name`);
  }

  /** Return just the service name, like the name for a PTR record. */
  get ptrName(): string {
    return [this.service, this.domain].join(".");
  }
}

/**
 * Encode QNAME without using name compression.
 *
 * Labels are encoded using UTF-8. This function can take either a single string,
 * with each label separated by dots, or a sequence of strings, and each element of
 * the sequence is treated as a single label.
 */
export function qnameEncode(name: string | string[]): Buffer {
  const encoded: number[] = [];
  let labels: string[];
  if (Array.isArray(name)) {
    labels = [...name];
  } else {
    // Try to parse it as a service instance name, so we can handle the instance
    // label having dots in it.
    try {
      const srvName = ServiceInstanceName.splitName(name);
      labels = [];
      if (srvName.instance) labels.push(srvName.instance);
      labels.push(...srvName.ptrName.split("."));
    } catch {
      labels = name.split(".");
    }
  }
  // Ensure there's always an empty label for the root domain
  if (labels.length === 0 || labels[labels.length - 1] !== "") {
    labels.push("");
  }
  for (const rawLabel of labels) {
    // Normalize all labels using NFC, as specified in RFC 6763, section 4.1.3
    const label = rawLabel.normalize("NFC");
    let encodedLabel = Buffer.from(label, "utf-8");
    let truncated = false;
    let current = label;
    // When truncating the label, we can't just stop at 63 bytes as that might be
    // splitting a multi-byte Unicode codepoint.
    while (encodedLabel.length > 63) {
      truncated = true;
      const codepoints = Array.from(current);
      codepoints.pop();
      current = codepoints.join("");
      encodedLabel = Buffer.from(current, "utf-8");
    }
    if (truncated) {
      LOGGER.warning(
        "A label (%s) is being truncated (to %s) in the DNS name '%s' as it is over 63 bytes long.",
        label,
        current,
        name,
      );
    }
    encoded.push(encodedLabel.length);
    if (encodedLabel.length === 0) {
      // If we've reached an empty label, assume this is the last component.
      break;
    }
    encoded.push(...encodedLabel);
  }
  return Buffer.from(encoded);
}

/** Unpack a DNS character string (single length byte followed by data). */
export function parseString(buffer: BytesReader): Buffer {
  const [chunkLength] = buffer.unpack(">B");
  return buffer.read(chunkLength);
}

/** Unpack a domain name, handling any name compression encountered. */
export function parseDomainName(buffer: BytesReader): string {
  const labels: string[] = [];
  let compressionOffset: number | null = null;
  while (buffer.remaining > 0) {
    const [length] = buffer.unpack(">B") as [number];
    if (length === 0) break;
    // The two high bits of the length are a flag for DNS name compression
    const lengthFlags = (length & 0xc0) >> 6;
    // The 10 and 01 flags are reserved
    if (lengthFlags !== 0 && lengthFlags !== 0b11) {
      throw new Error("invalid label length flags");
    }
    if (lengthFlags === 0b11) {
      const highBits = length & 0x3f;
      const low = buffer.read(1)[0];
      if (low === undefined) throw new Error("truncated compression pointer");
      const pointerPosition = buffer.tell() - 2;
      const newOffset = (highBits << 8) | low;
      // Pointers must refer to an earlier position, otherwise a malformed (or
      // malicious) packet can make us loop forever
      if (newOffset >= pointerPosition) {
        throw new Error(`invalid compression pointer ${newOffset} at ${pointerPosition}`);
      }
      if (compressionOffset === null) {
        compressionOffset = buffer.tell();
      }
      buffer.seek(newOffset);
    } else {
      const label = buffer.read(length);
      if (label.subarray(0, 4).toString("latin1") === "xn--") {
        labels.push(domainToUnicode(label.toString("ascii")));
      } else {
        labels.push(label.toString("utf-8"));
      }
    }
  }
  if (compressionOffset !== null) {
    buffer.seek(compressionOffset);
  }
  return labels.join(".");
}

/** Format a dict into a DNS-SD TXT record. */
export function formatTxtDict(data: Map<string | Uint8Array, unknown> | Record<string, unknown>): Buffer {
  const entries: Array<[string | Uint8Array, unknown]> = data instanceof Map ? [...data.entries()] : Object.entries(data);
  const parts: Buffer[] = [];
  for (const [key, value] of entries) {
    let record = typeof key === "string" ? Buffer.from(key, "utf-8") : Buffer.from(key);
    if (value !== null && value !== undefined) {
      let encodedValue: Buffer;
      if (value instanceof Uint8Array) encodedValue = Buffer.from(value);
      else if (typeof value === "boolean") encodedValue = Buffer.from(value ? "True" : "False");
      else encodedValue = Buffer.from(String(value), "utf-8");
      record = Buffer.concat([record, Buffer.from("="), encodedValue]);
    }
    parts.push(Buffer.from([record.length]), record);
  }
  const result = Buffer.concat(parts);
  return result.length === 0 ? Buffer.from([0]) : result;
}

/** Parse DNS-SD TXT records into a dict. */
export function parseTxtDict(buffer: BytesReader, length: number): CaseInsensitiveDict<Buffer> {
  const output = new CaseInsensitiveDict<Buffer>();
  const stopPosition = buffer.tell() + length;
  while (buffer.tell() < stopPosition) {
    const chunk = parseString(buffer);
    const eq = chunk.indexOf(0x3d);
    if (eq === -1) {
      // missing "=" means it's just present with no value.
      output.set(chunk.toString("ascii"), Buffer.alloc(0));
    } else {
      const key = chunk.subarray(0, eq);
      const value = chunk.subarray(eq + 1);
      if (key.length === 0) continue;
      // Keys are explicitly ASCII only
      if (key.some((b) => b > 0x7f)) {
        LOGGER.debug("Non-ASCII DNS-SD key encountered: %s", key);
        continue;
      }
      output.set(key.toString("ascii"), Buffer.from(value));
    }
  }
  return output;
}

export interface SrvRecord {
  priority: number;
  weight: number;
  port: number;
  target: string;
}

/** Parse DNS SRV record. */
export function parseSrvDict(buffer: BytesReader): SrvRecord {
  const [priority, weight, port] = buffer.unpack(">3H") as [number, number, number];
  // Name compression isn't allowed by the RFC, but let's accept it anyways
  const target = parseDomainName(buffer);
  return { priority, weight, port, target };
}

/** A DNS type ID. */
export enum QueryType {
  A = 0x01,
  PTR = 0x0c,
  TXT = 0x10,
  SRV = 0x21,
  ANY = 0xff,
}

/** Parse the RDATA from DNS resource record according to the type of the record. */
export function parseRdata(qtype: QueryType, buffer: BytesReader, length: number): any {
  switch (qtype) {
    case QueryType.A:
      if (length !== 4) {
        throw new RangeError(`An A record must have exactly 4 bytes of data (not ${length})`);
      }
      return ipFromBytes(buffer.read(length));
    case QueryType.PTR:
      return parseDomainName(buffer);
    case QueryType.TXT:
      return parseTxtDict(buffer, length);
    case QueryType.SRV:
      return parseSrvDict(buffer);
    default:
      return buffer.read(length);
  }
}

/** Represents the header to a DNS message. */
export class DnsHeader {
  constructor(
    readonly id: number,
    readonly flags: number,
    readonly qdcount: number,
    readonly ancount: number,
    readonly nscount: number,
    readonly arcount: number,
  ) {}

  static unpackRead(buffer: BytesReader): DnsHeader {
    const v = buffer.unpack(">6H") as number[];
    return new DnsHeader(v[0]!, v[1]!, v[2]!, v[3]!, v[4]!, v[5]!);
  }

  pack(): Buffer {
    return pack(">6H", this.id, this.flags, this.qdcount, this.ancount, this.nscount, this.arcount);
  }
}

/** Represents a DNS query. */
export class DnsQuestion {
  constructor(
    readonly qname: string,
    readonly qtype: QueryType | number,
    readonly qclass: number,
  ) {}

  static unpackRead(buffer: BytesReader): DnsQuestion {
    const qname = parseDomainName(buffer);
    const [qtype, qclass] = buffer.unpack(">2H") as [number, number];
    return new DnsQuestion(qname, qtype, qclass);
  }

  pack(): Buffer {
    return Buffer.concat([qnameEncode(this.qname), pack(">2H", this.qtype, this.qclass)]);
  }
}

const KNOWN_TYPES = new Set<number>([QueryType.A, QueryType.PTR, QueryType.TXT, QueryType.SRV, QueryType.ANY]);

/** Query type used for records of a known type whose data could not be parsed (raw data is kept). */
export const UNPARSED_TYPE = -1;

/** Represents a DNS resource record. */
export class DnsResource {
  constructor(
    readonly qname: string,
    readonly qtype: QueryType | number,
    readonly qclass: number,
    readonly ttl: number,
    readonly rdLength: number,
    readonly rd: any,
  ) {}

  static unpackRead(buffer: BytesReader): DnsResource {
    const qname = parseDomainName(buffer);
    const [qtype, qclass, ttl, rdLength] = buffer.unpack(">2HIH") as [number, number, number, number];
    const beforeRd = buffer.tell();
    if (beforeRd + rdLength > buffer.tell() + buffer.remaining) {
      throw new Error("resource data exceeds message length");
    }
    let rd: any;
    if (KNOWN_TYPES.has(qtype)) {
      try {
        rd = parseRdata(qtype, buffer, rdLength);
      } catch (ex) {
        LOGGER.debug("Failed to parse resource data for %s (type %d): %s", qname, qtype, ex);
        rd = null;
      }
      if (rd === null || buffer.tell() !== beforeRd + rdLength) {
        // Keep the raw data for a record we could not parse instead of dropping the
        // whole message (one odd record should not discard everything else)
        if (rd !== null) LOGGER.debug("Resource data length mismatch for %s (type %d)", qname, qtype);
        buffer.seek(beforeRd);
        rd = buffer.read(rdLength);
        return new DnsResource(qname, UNPARSED_TYPE, qclass, ttl, rdLength, rd);
      }
    } else {
      rd = buffer.read(rdLength);
    }
    return new DnsResource(qname, qtype, qclass, ttl, rdLength, rd);
  }
}

/** Represent a DNS message. */
export class DnsMessage {
  questions: DnsQuestion[] = [];
  answers: DnsResource[] = [];
  authorities: DnsResource[] = [];
  resources: DnsResource[] = [];

  constructor(
    public msgId = 0,
    public flags = 0x0120,
  ) {}

  /** Unpack bytes into a DnsMessage. */
  unpack(msg: Uint8Array): this {
    const buffer = new BytesReader(msg);
    const header = DnsHeader.unpackRead(buffer);
    this.msgId = header.id;
    this.flags = header.flags;

    for (let i = 0; i < header.qdcount; i++) this.questions.push(DnsQuestion.unpackRead(buffer));
    for (let i = 0; i < header.ancount; i++) this.answers.push(DnsResource.unpackRead(buffer));
    for (let i = 0; i < header.nscount; i++) this.authorities.push(DnsResource.unpackRead(buffer));
    for (let i = 0; i < header.arcount; i++) this.resources.push(DnsResource.unpackRead(buffer));
    return this;
  }

  /** Pack message into bytes. */
  pack(): Buffer {
    const header = new DnsHeader(
      this.msgId,
      this.flags,
      this.questions.length,
      this.answers.length,
      this.authorities.length,
      this.resources.length,
    );

    const parts: Buffer[] = [header.pack()];
    for (const question of this.questions) parts.push(question.pack());

    for (const answer of this.answers) {
      const data = qnameEncode(answer.rd);
      parts.push(qnameEncode(answer.qname), pack(">HHIH", answer.qtype, answer.qclass, answer.ttl, data.length), data);
    }

    for (const section of [this.authorities, this.resources]) {
      for (const resource of section) {
        const rd: Buffer = resource.rd;
        parts.push(qnameEncode(resource.qname), pack(">HHIH", resource.qtype, resource.qclass, resource.ttl, rd.length), rd);
      }
    }
    return Buffer.concat(parts);
  }

  toString(): string {
    const hex4 = (v: number) => v.toString(16).toUpperCase().padStart(4, "0");
    return (
      `MsgId=0x${hex4(this.msgId)}\nFlags=0x${hex4(this.flags)}\n` +
      `Questions=${JSON.stringify(this.questions)}\nAnswers=${JSON.stringify(this.answers)}\n` +
      `Authorities=${JSON.stringify(this.authorities)}\nResources=${JSON.stringify(this.resources)}`
    );
  }
}
