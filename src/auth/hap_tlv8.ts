/**
 * Implementation of TLV8 used by HomeKit pairing process.
 *
 * Note that this implementation only supports one level of value, i.e. no dicts in
 * dicts. TLV data is represented as Map<number, Buffer> to preserve insertion order.
 */

/** Correspond to TLV values in HAP specification. */
export enum TlvValue {
  // Standardized keys
  Method = 0x00,
  Identifier = 0x01,
  Salt = 0x02,
  PublicKey = 0x03,
  Proof = 0x04,
  EncryptedData = 0x05,
  SeqNo = 0x06,
  Error = 0x07,
  BackOff = 0x08,
  Certificate = 0x09,
  Signature = 0x0a,
  Permissions = 0x0b,
  FragmentData = 0x0c,
  FragmentLast = 0x0d,

  // Apple internal(?)
  Name = 0x11,
  Flags = 0x13,
}

/** Flags used with TlvValue.Flags. */
export enum Flags {
  TransientPairing = 0x10,
}

/** Correspond to error codes in HAP specification. */
export enum ErrorCode {
  Unknown = 0x01,
  Authentication = 0x02,
  BackOff = 0x03,
  MaxPeers = 0x04,
  MaxTries = 0x05,
  Unavailable = 0x06,
  Busy = 0x07,
}

/** Correspond to methods in HAP specification. */
export enum Method {
  PairSetup = 0x00,
  PairSetupWithAuth = 0x01,
  PairVerify = 0x02,
  AddPairing = 0x03,
  RemovePairing = 0x04,
  ListPairing = 0x05,
}

/** Correspond to states in HAP specification. */
export enum State {
  M1 = 0x01,
  M2 = 0x02,
  M3 = 0x03,
  M4 = 0x04,
  M5 = 0x05,
  M6 = 0x06,
}

export type TlvData = Map<number, Buffer>;
export type TlvInput = Map<number, Uint8Array> | Array<[number, Uint8Array]> | Record<number, Uint8Array>;

/**
 * Parse TLV8 bytes into a map.
 *
 * If value is larger than 255 bytes, it is split up in multiple chunks. So the same
 * tag might occur several times.
 */
export function readTlv(data: Uint8Array): TlvData {
  const result: TlvData = new Map();
  let pos = 0;
  while (pos < data.length) {
    const tag = data[pos]!;
    const length = data[pos + 1] ?? 0;
    const value = Buffer.from(data.subarray(pos + 2, pos + 2 + length));
    const existing = result.get(tag);
    result.set(tag, existing ? Buffer.concat([existing, value]) : value);
    pos += 2 + length;
  }
  return result;
}

function entriesOf(data: TlvInput): Array<[number, Uint8Array]> {
  if (data instanceof Map) return [...data.entries()];
  if (Array.isArray(data)) return data;
  return Object.entries(data).map(([k, v]) => [Number(k), v as Uint8Array]);
}

/** Convert a map to TLV8 bytes. All values must be bytes. */
export function writeTlv(data: TlvInput): Buffer {
  const parts: Buffer[] = [];
  for (const [key, value] of entriesOf(data)) {
    let length = value.length;
    let pos = 0;
    // A tag with length > 255 is added multiple times and concatenated into one
    // buffer when reading the TLV again.
    while (pos < value.length) {
      const size = Math.min(length, 255);
      parts.push(Buffer.from([key, size]), Buffer.from(value.subarray(pos, pos + size)));
      pos += size;
      length -= size;
    }
  }
  return Buffer.concat(parts);
}

function enumValueName(value: number, enumType: Record<number, string>): string {
  return enumType[value] ?? "0x" + value.toString(16);
}

function leInt(value: Uint8Array): number {
  let result = 0;
  for (let i = value.length - 1; i >= 0; i--) result = result * 256 + value[i]!;
  return result;
}

/**
 * Create simplified string of TLV8 data.
 *
 * Method, sequence number, error and backoff time are parsed while the rest are just
 * summarized with value byte length.
 */
export function stringify(data: TlvInput): string {
  const output: string[] = [];
  for (const [key, value] of entriesOf(data)) {
    const keyName = TlvValue[key];
    if (keyName === undefined) {
      output.push(`0x${key.toString(16)}=${value.length}bytes`);
    } else if (key === TlvValue.Method) {
      output.push(`${keyName}=${enumValueName(leInt(value), Method)}`);
    } else if (key === TlvValue.SeqNo) {
      output.push(`${keyName}=${enumValueName(leInt(value), State)}`);
    } else if (key === TlvValue.Error) {
      output.push(`${keyName}=${enumValueName(leInt(value), ErrorCode)}`);
    } else if (key === TlvValue.BackOff) {
      output.push(`${keyName}=${leInt(value)}s`);
    } else {
      output.push(`${keyName}=${value.length}bytes`);
    }
  }
  return output.join(", ");
}
