/** Support functions used in library. */

import { getEnv } from "./env.ts";
import { BackOffError, ConnectionFailedError, isOSError, NoCredentialsError } from "../exceptions.ts";
import { TimeoutError } from "./asyncio.ts";
import { type Logger, LogLevel } from "./logging.ts";
import { Model, typeName } from "./model.ts";

export { asyncTimeout } from "./asyncio.ts";

const PROTOBUF_LINE_LENGTH = 150;
const BINARY_LINE_LENGTH = 512;

function shorten(text: string, length: number): string {
  return text.length < length ? text : text.slice(0, length - 3) + "...";
}

function logValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  return String(value);
}

/**
 * Create a string representation of an object with long strings/bytes shortened.
 *
 * Equivalent of the prettydataclass decorator in Python.
 */
export function prettyRepr(name: string, fields: Record<string, unknown>, maxLength = 150): string {
  const format = (value: unknown): string => {
    if (typeof value === "string") return shorten(value, maxLength);
    if (value instanceof Uint8Array) {
      const latin = Buffer.from(value).toString("latin1");
      return `b'${shorten(latin, maxLength)}'`;
    }
    if (value === null || value === undefined) return "None";
    return String(value);
  };
  return `${name}(` + Object.entries(fields).map(([k, v]) => `${k}=${format(v)}`).join(", ") + ")";
}

/** Call a function and re-map exceptions to match pyatv interface. */
export async function errorHandler<T>(
  func: (...args: any[]) => Promise<T>,
  fallback: new (message?: string) => Error,
  ...args: any[]
): Promise<T> {
  try {
    return await func(...args);
  } catch (ex) {
    if (isOSError(ex) || ex instanceof TimeoutError) {
      throw new ConnectionFailedError(String((ex as Error)?.message ?? ex), { cause: ex });
    }
    if (ex instanceof BackOffError || ex instanceof NoCredentialsError) throw ex;
    const err = new fallback(String((ex as Error)?.message ?? ex));
    (err as any).cause = ex;
    throw err;
  }
}

/** Log binary data if debug is enabled. */
export function logBinary(
  logger: Pick<Logger, "isEnabledFor" | "debug">,
  message: string,
  kwargs: Record<string, unknown> = {},
  level: LogLevel = LogLevel.DEBUG,
): void {
  if (logger.isEnabledFor(level)) {
    const overrideLength = parseInt(getEnv("PYATV_BINARY_MAX_LINE") ?? "0", 10) || 0;
    const lineLength = overrideLength || BINARY_LINE_LENGTH;
    const output = Object.keys(kwargs)
      .sort()
      .map((k) => `${k}=${shorten(logValue(kwargs[k]), lineLength)}`);
    logger.debug("%s (%s)", message, output.join(", "));
  }
}

/** Text formatter for protobuf messages (registered by protobuf module). */
let protobufFormatter: (message: unknown) => string = (message) => JSON.stringify(message);

export function setProtobufFormatter(formatter: (message: unknown) => string): void {
  protobufFormatter = formatter;
}

/** Log protobuf message and shorten line length. */
export function logProtobuf(logger: Pick<Logger, "isEnabledFor" | "debug">, text: string, message: unknown): void {
  if (logger.isEnabledFor(LogLevel.DEBUG)) {
    const overrideLength = parseInt(getEnv("PYATV_PROTOBUF_MAX_LINE") ?? "0", 10) || 0;
    const lineLength = overrideLength || PROTOBUF_LINE_LENGTH;
    const lines = protobufFormatter(message).split("\n").filter((l) => l.length > 0);
    const msgStr = lines.map((x) => shorten(x, lineLength)).join("\n");
    logger.debug("%s: %s", text, msgStr);
  }
}

const warnedDeprecations = new Set<string>();

/** Emit a deprecation warning once for a function name. */
export function deprecated(name: string): void {
  if (process.env.PYATV_TESTING || warnedDeprecations.has(name)) return;
  warnedDeprecations.add(name);
  process.emitWarning(`Call to deprecated function ${name}.`, "DeprecationWarning");
}

/** Map a value in one range to another. */
export function mapRange(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  if (inMax - inMin <= 0.0) throw new RangeError("invalid input range");
  if (outMax - outMin <= 0.0) throw new RangeError("invalid output range");
  if (value < inMin || value > inMax) throw new RangeError("input value out of range");
  return ((value - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin;
}

export class AssertionError extends Error {
  constructor(message?: string) {
    super(message ?? "assertion failed");
    this.name = "AssertionError";
  }
}

/** Repeatably modify a unique identifier to avoid collisions. */
export function shiftHexIdentifier(identifier: string): string {
  if (identifier.length < 2) throw new AssertionError();
  const first = identifier.slice(0, 2);
  const rest = identifier.slice(2);
  let shifted = ((parseInt(first, 16) + 1) % 256).toString(16).padStart(2, "0");
  if (identifier === identifier.toUpperCase() && /[A-Z]/.test(identifier)) shifted = shifted.toUpperCase();
  return shifted + rest;
}

/**
 * Recursively traverse a model and print values.
 *
 * Each field is presented with a "dotted" path, current value and data type.
 */
export function stringifyModel(model: Model): string[] {
  const output: string[] = [];
  const recurse = (current: Model, prefix: string) => {
    for (const [name, spec] of Object.entries(current.schema)) {
      const value = (current as any)[name];
      if (value instanceof Model) {
        recurse(value, `${prefix}${name}.`);
      } else {
        const shown = value === null || value === undefined ? "None" : String(value);
        output.push(`${prefix}${name} = ${shown} (${typeName(spec.type)})`);
      }
    }
  };
  recurse(model, "");
  return output;
}

/** Update a field in a model using dotted string path. */
export function updateModelField(model: Model, field: string, value: string | number | boolean | null): void {
  const idx = field.indexOf(".");
  const nextField = idx === -1 ? field : field.slice(0, idx);

  if (!(nextField in model.schema)) {
    throw new AttributeError(`${model.constructor.name} has no field ${nextField}`);
  }

  if (idx !== -1) {
    updateModelField((model as any)[nextField] as Model, field.slice(idx + 1), value);
  } else {
    (model as any)[field] = model.validateField(field, value);
  }
}

export class AttributeError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "AttributeError";
  }
}
