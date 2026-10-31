/** Import all protocol implementations (registering them in PROTOCOLS). */

import { Protocol } from "../const.ts";
import { PROTOCOLS } from "./index.ts";

// Order matters: AirPlay, Companion, DMAP, MRP, RAOP (same as Python)
const ORDER = [Protocol.AirPlay, Protocol.Companion, Protocol.DMAP, Protocol.MRP, Protocol.RAOP];

export function sortedProtocols() {
  return ORDER.filter((p) => PROTOCOLS.has(p)).map((p) => [p, PROTOCOLS.get(p)!] as const);
}
