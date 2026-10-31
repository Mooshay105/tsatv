/**
 * Minimal logging module modelled after Python's logging.
 *
 * Loggers are hierarchical by dotted name and messages use printf style formatting
 * (%s, %d, %x, ...) just like in Python.
 */

export enum LogLevel {
  NOTSET = 0,
  DEBUG = 10,
  INFO = 20,
  WARNING = 30,
  ERROR = 40,
  CRITICAL = 50,
}

export const DEBUG = LogLevel.DEBUG;
export const INFO = LogLevel.INFO;
export const WARNING = LogLevel.WARNING;
export const ERROR = LogLevel.ERROR;

export interface LogRecord {
  name: string;
  level: LogLevel;
  levelname: string;
  message: string;
  args: unknown[];
  created: number;
  error?: unknown;
}

export type LogHandler = (record: LogRecord) => void;

function pad(str: string, width: number, flags: string): string {
  if (str.length >= width) return str;
  if (flags.includes("-")) return str.padEnd(width, " ");
  if (flags.includes("0")) {
    const neg = str.startsWith("-");
    const body = neg ? str.slice(1) : str;
    return (neg ? "-" : "") + body.padStart(width - (neg ? 1 : 0), "0");
  }
  return str.padStart(width, " ");
}

/** Python repr-ish conversion of a value. */
export function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return bytesRepr(value);
  if (Array.isArray(value)) return "[" + value.map(pyRepr).join(", ") + "]";
  if (value instanceof Error) return value.message;
  if (typeof value === "object") {
    const toStr = (value as { toString?: () => string }).toString;
    if (toStr && toStr !== Object.prototype.toString) return toStr.call(value);
    try {
      return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function pyRepr(value: unknown): string {
  if (typeof value === "string") return `'${value}'`;
  return pyStr(value);
}

export function bytesRepr(data: Uint8Array): string {
  let out = "b'";
  for (const b of data) {
    if (b === 0x5c) out += "\\\\";
    else if (b === 0x27) out += "\\'";
    else if (b === 0x0a) out += "\\n";
    else if (b === 0x0d) out += "\\r";
    else if (b === 0x09) out += "\\t";
    else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
    else out += "\\x" + b.toString(16).padStart(2, "0");
  }
  return out + "'";
}

/** Python style "%" formatting. */
export function pyFormat(fmt: string, args: unknown[]): string {
  let argIndex = 0;
  return fmt.replace(/%([-0+ #]*)(\d+|\*)?(?:\.(\d+))?([sdixXfrcoegE%])/g, (match, flags, width, precision, conv) => {
    if (conv === "%") return "%";
    if (width === "*") width = String(args[argIndex++]);
    const value = args[argIndex++];
    const w = width ? parseInt(width, 10) : 0;
    let out: string;
    switch (conv) {
      case "s":
        out = pyStr(value);
        if (precision !== undefined) out = out.slice(0, parseInt(precision, 10));
        break;
      case "r":
        out = pyRepr(value);
        break;
      case "d":
      case "i":
        out =
          typeof value === "bigint"
            ? value.toString()
            : String(Math.trunc(Number(value as number)));
        break;
      case "x":
        out = (typeof value === "bigint" ? value : BigInt(Math.trunc(Number(value)))).toString(16);
        if (flags.includes("#")) out = "0x" + out;
        break;
      case "X":
        out = (typeof value === "bigint" ? value : BigInt(Math.trunc(Number(value)))).toString(16).toUpperCase();
        if (flags.includes("#")) out = "0X" + out;
        break;
      case "o":
        out = Math.trunc(Number(value)).toString(8);
        break;
      case "f":
        out = Number(value).toFixed(precision !== undefined ? parseInt(precision, 10) : 6);
        break;
      case "e":
      case "E":
        out = Number(value).toExponential(precision !== undefined ? parseInt(precision, 10) : 6);
        if (conv === "E") out = out.toUpperCase();
        break;
      case "g":
        out = String(Number(value));
        break;
      case "c":
        out = typeof value === "number" ? String.fromCharCode(value) : String(value);
        break;
      default:
        out = match;
    }
    return pad(out, w, flags);
  });
}

const loggers = new Map<string, Logger>();
const handlers: LogHandler[] = [];
let rootLevel: LogLevel = (() => {
  const env = typeof process !== "undefined" ? process.env.PYATV_LOG_LEVEL : undefined;
  if (env && env.toUpperCase() in LogLevel) {
    return LogLevel[env.toUpperCase() as keyof typeof LogLevel] as LogLevel;
  }
  return LogLevel.WARNING;
})();

function defaultHandler(record: LogRecord): void {
  const line = `${record.levelname}:${record.name}:${record.message}`;
  if (record.level >= LogLevel.WARNING) console.error(line);
  else console.log(line);
}

let useDefaultHandler = true;

export class Logger {
  level: LogLevel = LogLevel.NOTSET;

  constructor(readonly name: string) {}

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getEffectiveLevel(): LogLevel {
    let name = this.name;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const logger = loggers.get(name);
      if (logger && logger.level !== LogLevel.NOTSET) return logger.level;
      const idx = name.lastIndexOf(".");
      if (idx === -1) break;
      name = name.slice(0, idx);
    }
    return rootLevel;
  }

  isEnabledFor(level: LogLevel): boolean {
    return level >= this.getEffectiveLevel();
  }

  log(level: LogLevel, message: string, ...args: unknown[]): void {
    if (!this.isEnabledFor(level)) return;
    let error: unknown;
    if (args.length > 0 && args[args.length - 1] instanceof Error && !message.includes("%")) {
      error = args.pop();
    }
    const record: LogRecord = {
      name: this.name,
      level,
      levelname: LogLevel[level] ?? String(level),
      message: args.length > 0 ? pyFormat(message, args) : message,
      args,
      created: Date.now() / 1000,
      error,
    };
    if (useDefaultHandler) defaultHandler(record);
    for (const handler of handlers) handler(record);
  }

  debug(message: string, ...args: unknown[]): void {
    this.log(LogLevel.DEBUG, message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.log(LogLevel.INFO, message, ...args);
  }

  warning(message: string, ...args: unknown[]): void {
    this.log(LogLevel.WARNING, message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.warning(message, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    this.log(LogLevel.ERROR, message, ...args);
  }

  exception(message: string, ...args: unknown[]): void {
    this.log(LogLevel.ERROR, message, ...args);
  }
}

/** Get (or create) a logger with a given name. */
export function getLogger(name = "root"): Logger {
  let logger = loggers.get(name);
  if (!logger) {
    logger = new Logger(name);
    loggers.set(name, logger);
  }
  return logger;
}

/** Set level of root logger. */
export function setRootLevel(level: LogLevel): void {
  rootLevel = level;
}

export function getRootLevel(): LogLevel {
  return rootLevel;
}

/** Add a log handler; returns function that removes it again. */
export function addHandler(handler: LogHandler): () => void {
  handlers.push(handler);
  return () => {
    const idx = handlers.indexOf(handler);
    if (idx >= 0) handlers.splice(idx, 1);
  };
}

/** Enable/disable the default console handler. */
export function setDefaultHandlerEnabled(enabled: boolean): void {
  useDefaultHandler = enabled;
}
