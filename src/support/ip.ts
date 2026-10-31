/** Minimal IPv4 address helpers (Python ipaddress equivalents). */

export function ipToInt(address: string): number {
  const parts = address.split(".");
  if (parts.length !== 4) throw new RangeError(`invalid IPv4 address: ${address}`);
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) throw new RangeError(`invalid IPv4 address: ${address}`);
    const value = parseInt(part, 10);
    if (value > 255) throw new RangeError(`invalid IPv4 address: ${address}`);
    result = result * 256 + value;
  }
  return result;
}

export function intToIp(value: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join(".");
}

export function isIPv4(address: string): boolean {
  try {
    ipToInt(address);
    return true;
  } catch {
    return false;
  }
}

export function ipFromBytes(data: Uint8Array): string {
  if (data.length !== 4) throw new RangeError("IPv4 address must be 4 bytes");
  return Array.from(data).join(".");
}

export function ipToBytes(address: string): Buffer {
  return Buffer.from(address.split(".").map((p) => parseInt(p, 10)));
}

function inRange(address: string, network: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((ipToInt(address) & mask) >>> 0) === ((ipToInt(network) & mask) >>> 0);
}

export function isLoopback(address: string): boolean {
  return inRange(address, "127.0.0.0", 8);
}

export function isLinkLocal(address: string): boolean {
  return inRange(address, "169.254.0.0", 16);
}

/** Return if address is private (RFC1918, loopback, link local, etc. like Python). */
export function isPrivate(address: string): boolean {
  const ranges: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 29],
    ["192.0.0.170", 31],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["240.0.0.0", 4],
    ["255.255.255.255", 32],
  ];
  return ranges.some(([net, prefix]) => inRange(address, net, prefix));
}

/** Return if address is within network/prefix. */
export function inNetwork(address: string, network: string, prefix: number): boolean {
  return inRange(address, network, prefix);
}
