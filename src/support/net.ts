/** Various network utility helpers. */

import dgram from "node:dgram";
import type { Socket as NetSocket } from "node:net";
import os from "node:os";
import { inNetwork, isIPv4, isLoopback, isPrivate } from "./ip.ts";
import { getLogger } from "./logging.ts";

const LOGGER = getLogger("pyatv.support.net");

export interface AdapterIP {
  ip: string;
  networkPrefix: number;
  niceName: string;
  isIPv4: boolean;
}

export interface Adapter {
  name: string;
  niceName: string;
  ips: AdapterIP[];
}

function cidrToPrefix(netmask: string): number {
  return netmask
    .split(".")
    .map((p) => parseInt(p, 10).toString(2).replace(/0/g, "").length)
    .reduce((a, b) => a + b, 0);
}

/** Return network adapters on this host (ifaddr.get_adapters equivalent). */
export function getAdapters(): Adapter[] {
  const result: Adapter[] = [];
  for (const [name, infos] of Object.entries(os.networkInterfaces())) {
    const ips: AdapterIP[] = (infos ?? []).map((info) => ({
      ip: info.address,
      networkPrefix:
        info.cidr !== null && info.cidr !== undefined
          ? parseInt(info.cidr.split("/")[1] ?? "0", 10)
          : info.family === "IPv4"
            ? cidrToPrefix(info.netmask)
            : 64,
      niceName: name,
      isIPv4: info.family === "IPv4",
    }));
    result.push({ name, niceName: name, ips });
  }
  return result;
}

/** Create an adapter description (mainly used in tests). */
export function makeAdapter(name: string, ips: Array<[string, number]>): Adapter {
  return {
    name,
    niceName: name,
    ips: ips.map(([ip, prefix]) => ({ ip, networkPrefix: prefix, niceName: name, isIPv4: isIPv4(ip) })),
  };
}

/** Return a port that is unused on the current host. */
export function unusedPort(): number {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = server.port;
  server.stop(true);
  return port;
}

/** Create a multicast capable socket bound to address and port. */
export async function mcastSocket(address: string | null, port = 0): Promise<dgram.Socket> {
  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  LOGGER.debug("Binding on %s:%d", address ?? "*", port);
  await new Promise<void>((resolve, reject) => {
    sock.once("error", reject);
    sock.bind({ port, address: address ?? undefined, exclusive: false }, () => {
      sock.off("error", reject);
      resolve();
    });
  });

  try {
    sock.setMulticastTTL(10);
    sock.setMulticastLoopback(true);
  } catch {
    // Ignore
  }

  if (address !== null) {
    try {
      sock.setMulticastInterface(address);
    } catch {
      // Ignore
    }
    try {
      sock.addMembership("224.0.0.251", address);
    } catch {
      // Ignore
    }
  }
  return sock;
}

/** Get address of a local interface within same subnet as provided address. */
export function getLocalAddressReaching(destIp: string): string | null {
  for (const adapter of getAdapters()) {
    for (const addr of adapter.ips.filter((a) => a.isIPv4)) {
      if (inNetwork(destIp, addr.ip, addr.networkPrefix)) {
        return addr.ip;
      }
    }
  }
  return null;
}

/** Get private (RFC1918 + loopback) addresses from all interfaces. */
export function getPrivateAddresses(includeLoopback = true): string[] {
  const addresses: string[] = [];
  for (const adapter of getAdapters()) {
    for (const addr of adapter.ips.filter((a) => a.isIPv4)) {
      if (isLoopback(addr.ip) && !includeLoopback) continue;
      if (isPrivate(addr.ip)) addresses.push(addr.ip);
    }
  }
  return addresses;
}

/** Configure keep-alive on a socket. */
export function tcpKeepalive(sock: NetSocket | { setKeepAlive?: (enable: boolean, delay?: number) => unknown }): void {
  if (typeof sock.setKeepAlive !== "function") {
    LOGGER.warning("Unable to configure keep-alive on socket");
    return;
  }
  // Default values are 1s idle time (interval and count are set by the system)
  sock.setKeepAlive(true, 1000);
  LOGGER.debug("Configured keep-alive on socket (%s)", process.platform);
}
