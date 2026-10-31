/** Scripts bundled with pyatv. */

import { appendFileSync } from "node:fs";
import { isIP } from "node:net";
import { Protocol, VERSION } from "../const.ts";
import type { Storage } from "../interface.ts";
import { FileStorage } from "../storage/file_storage.ts";
import { MemoryStorage } from "../storage/memory_storage.ts";
import { addHandler, getLogger, type LogLevel, type LogRecord, setDefaultHandlerEnabled, setRootLevel } from "../support/logging.ts";
import { ArgumentParser, ArgumentTypeError, type Namespace } from "./argparse.ts";
import { getIO } from "./io.ts";

export { ArgumentParser, ArgumentTypeError, SystemExit, type Namespace } from "./argparse.ts";

const LOGGER = getLogger("pyatv.scripts");

const PROTOCOLS: Record<string, Protocol> = Object.fromEntries(
  Object.entries(Protocol)
    .filter(([, value]) => typeof value === "number")
    .map(([name, value]) => [name.toLowerCase(), value as Protocol]),
);

/** Lower case name of a protocol (e.g. "airplay"). */
export const protocolName = (protocol: Protocol): string => Protocol[protocol]!.toLowerCase();

/** All protocols in definition order. */
export const ALL_PROTOCOLS: Protocol[] = Object.values(PROTOCOLS);

/** Transform protocol in string format to internal representation. */
export function transformProtocol(value: string): Protocol {
  if (value in PROTOCOLS) return PROTOCOLS[value]!;
  throw new ArgumentTypeError("Valid protocols are: " + Object.keys(PROTOCOLS).join(", "));
}

/** Transform scan hosts into array. */
export function verifyScanHosts(value: string): string[] {
  const hosts = value.split(",");
  // Simple verification that IP addresses has correct format
  for (const host of hosts) {
    if (isIP(host) === 0) throw new ArgumentTypeError(`'${host}' does not appear to be an IPv4 or IPv6 address`);
  }
  return hosts;
}

/** Transform scan protocols into a set. */
export function verifyScanProtocols(value: string): Set<Protocol> {
  return new Set(value.split(",").map(transformProtocol));
}

/** Transform output format to function. */
export function transformOutput(value: string): (data: unknown) => string {
  if (value === "json") return pyJsonDumps;
  throw new ArgumentTypeError("Valid formats are: json");
}

/** Transform identifiers into a set if multiple. */
export function transformIdentifiers(value: string): string | Set<string> {
  const identifiers = value.split(",");
  return identifiers.length === 1 ? value : new Set(identifiers);
}

/** JSON encoding with the same separators as Python's json.dumps. */
export function pyJsonDumps(data: unknown): string {
  const encode = (value: unknown): string => {
    if (value === null || value === undefined) return "null";
    if (Array.isArray(value)) return `[${value.map(encode).join(", ")}]`;
    if (typeof value === "object") {
      return `{${Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => `${JSON.stringify(k)}: ${encode(v)}`)
        .join(", ")}}`;
    }
    return JSON.stringify(value);
  };
  return encode(data);
}

/** Return a parser with common arguments used by all scripts. */
export function createCommonParser(prog: string): ArgumentParser {
  const parser = new ArgumentParser(prog);
  const settingsGroup = parser.addArgumentGroup("settings");
  settingsGroup.addArgument("--storage", { choices: ["file", "none"], default: "file", help: "storage backend for settings" });
  settingsGroup.addArgument("--storage-filename", {
    default: "default", // Corresponds to FileStorage.defaultStorage()
    help: "file used by file storage",
  });
  return parser;
}

/** Get storage module based on user configuration. */
export function getStorage(args: Namespace): Storage {
  if (args.storage === "file") {
    if (args.storage_filename === "default") return FileStorage.defaultStorage();
    return new FileStorage(args.storage_filename);
  }
  return new MemoryStorage();
}

/** Log current version of pyatv. */
export function logCurrentVersion(): void {
  LOGGER.debug("Running with pyatv %s", VERSION);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Format a log record like "%(asctime)s %(levelname)s [%(name)s]: %(message)s". */
export function formatRecord(record: LogRecord): string {
  const d = new Date(record.created * 1000);
  const asctime = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  let text = `${asctime} ${record.levelname} [${record.name}]: ${record.message}`;
  if (record.error) text += `\n${formatException(record.error)}`;
  return text;
}

/**
 * Configure logging (equivalent of logging.basicConfig).
 *
 * Logs are written to standard output (default) or appended to a file. Returns a
 * function that removes the handler again.
 */
export function basicConfig(level: LogLevel, options: { filename?: string } = {}): () => void {
  setDefaultHandlerEnabled(false);
  setRootLevel(level);
  return addHandler((record) => {
    if (record.level < level) return;
    const text = formatRecord(record) + "\n";
    if (options.filename) appendFileSync(options.filename, text);
    else getIO().stdout(text);
  });
}

/** Format an exception including stack trace (like traceback.format_exception). */
export function formatException(error: unknown): string {
  if (error instanceof Error) {
    let text = error.stack ?? `${error.name}: ${error.message}`;
    if (!text.includes(error.name)) text = `${error.name}: ${error.message}\n${text}`;
    if (error.cause) text += `\n\nThe above exception was the direct cause of the following exception:\n\n${formatException(error.cause)}`;
    return text;
  }
  return String(error);
}

/** Convert a camelCase name to snake_case (e.g. playPause -> play_pause). */
export const toSnakeCase = (name: string): string => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Convert a snake_case name to camelCase (e.g. play_pause -> playPause). */
export const toCamelCase = (name: string): string => name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
