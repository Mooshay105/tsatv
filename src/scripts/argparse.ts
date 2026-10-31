/**
 * Minimal command line argument parser modelled after Python's argparse.
 *
 * Only the features used by the bundled scripts are implemented: optional arguments
 * (with unique prefix matching of long options), positional arguments (single value or
 * nargs "+"/"*"/"?"), store/store_true/version actions, value transformations, choices
 * and argument groups (for help output).
 */

import { getIO } from "./io.ts";

/** Raised to exit the application (like SystemExit in Python). */
export class SystemExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
    this.name = "SystemExit";
  }
}

/** Raised by type/action functions when a value is invalid. */
export class ArgumentTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgumentTypeError";
  }
}

export type Nargs = "+" | "*" | "?";

export interface ArgumentOptions {
  dest?: string;
  help?: string;
  default?: unknown;
  /** "store" (default), "store_true", "version" or a custom transform of the value. */
  action?: "store" | "store_true" | "version" | ((value: string) => unknown);
  /** Convert value (applied before action). */
  type?: (value: string) => unknown;
  nargs?: Nargs;
  choices?: string[];
  metavar?: string;
  version?: string;
}

interface Argument extends ArgumentOptions {
  flags: string[];
  positional: boolean;
  dest: string;
  group: string;
}

export type Namespace = Record<string, any>;

const destFromFlags = (flags: string[]): string => {
  const long = flags.find((f) => f.startsWith("--")) ?? flags[0]!;
  return long.replace(/^-+/, "").replaceAll("-", "_");
};

/** A group of arguments (only affects help output). */
export class ArgumentGroup {
  constructor(
    private readonly parser: ArgumentParser,
    readonly title: string,
  ) {}

  addArgument(...args: [...string[], ArgumentOptions] | string[]): void {
    this.parser.addArgumentToGroup(this.title, args);
  }
}

export class ArgumentParser {
  private readonly args: Argument[] = [];
  readonly groups: string[] = ["positional arguments", "options"];

  constructor(
    readonly prog: string,
    readonly description: string | null = null,
  ) {
    this.addArgument("-h", "--help", { action: "store_true", help: "show this help message and exit", dest: "__help" });
  }

  addArgument(...args: [...string[], ArgumentOptions] | string[]): void {
    this.addArgumentToGroup(null, args);
  }

  addArgumentGroup(title: string): ArgumentGroup {
    if (!this.groups.includes(title)) this.groups.push(title);
    return new ArgumentGroup(this, title);
  }

  /** @internal */
  addArgumentToGroup(group: string | null, args: Array<string | ArgumentOptions>): void {
    const last = args[args.length - 1];
    const options: ArgumentOptions = typeof last === "object" ? (last as ArgumentOptions) : {};
    const flags = args.filter((a): a is string => typeof a === "string");
    const positional = !flags[0]!.startsWith("-");
    const dest = options.dest ?? (positional ? flags[0]! : destFromFlags(flags));
    this.args.push({
      ...options,
      flags,
      positional,
      dest,
      group: group ?? (positional ? "positional arguments" : "options"),
    });
  }

  private usage(): string {
    const parts = [this.prog];
    for (const arg of this.args) {
      if (arg.positional) {
        const name = arg.metavar ?? arg.dest;
        parts.push(arg.nargs === "+" ? `${name} [${name} ...]` : arg.nargs === "*" || arg.nargs === "?" ? `[${name}]` : name);
      } else if (arg.dest !== "__help") {
        const flag = arg.flags[0]!;
        parts.push(arg.action === "store_true" || arg.action === "version" ? `[${flag}]` : `[${flag} ${this.metavar(arg)}]`);
      }
    }
    return `usage: ${parts.join(" ")}`;
  }

  private metavar(arg: Argument): string {
    return arg.metavar ?? arg.dest.toUpperCase();
  }

  /** Return full help text. */
  formatHelp(): string {
    const lines = [this.usage(), ""];
    if (this.description) lines.push(this.description, "");
    for (const group of this.groups) {
      const members = this.args.filter((a) => a.group === group);
      if (members.length === 0) continue;
      lines.push(`${group}:`);
      for (const arg of members) {
        const name = arg.positional
          ? (arg.metavar ?? arg.dest)
          : arg.flags.map((f) => (arg.action === "store_true" || arg.action === "version" ? f : `${f} ${this.metavar(arg)}`)).join(", ");
        let help = arg.help ?? "";
        if (arg.choices) help += ` {${arg.choices.join(",")}}`;
        if (!arg.positional && arg.default !== undefined && arg.default !== null && typeof arg.default !== "function" && arg.action !== "store_true") {
          help += ` (default: ${String(arg.default)})`;
        }
        lines.push(`  ${name.padEnd(30)} ${help}`.trimEnd());
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  /** Print usage and an error message, then exit with code 2. */
  error(message: string): never {
    const io = getIO();
    io.stderr(`${this.usage()}\n${this.prog}: error: ${message}\n`);
    throw new SystemExit(2);
  }

  private findOption(flag: string): Argument {
    const exact = this.args.find((a) => !a.positional && a.flags.includes(flag));
    if (exact) return exact;
    if (flag.startsWith("--")) {
      const candidates = this.args.filter((a) => !a.positional && a.flags.some((f) => f.startsWith("--") && f.startsWith(flag)));
      if (candidates.length === 1) return candidates[0]!;
      if (candidates.length > 1) {
        const names = candidates.map((c) => c.flags.find((f) => f.startsWith(flag))).join(", ");
        this.error(`ambiguous option: ${flag} could match ${names}`);
      }
    }
    this.error(`unrecognized arguments: ${flag}`);
  }

  private convert(arg: Argument, value: string): unknown {
    try {
      if (arg.choices && !arg.choices.includes(value)) {
        throw new ArgumentTypeError(`invalid choice: '${value}' (choose from ${arg.choices.map((c) => `'${c}'`).join(", ")})`);
      }
      let converted: unknown = arg.type ? arg.type(value) : value;
      if (typeof arg.action === "function") converted = arg.action(converted as string);
      return converted;
    } catch (ex) {
      const name = arg.positional ? arg.dest : arg.flags.join("/");
      this.error(`argument ${name}: ${(ex as Error).message}`);
    }
  }

  /** Parse arguments (without program name). */
  parseArgs(argv: string[]): Namespace {
    const ns: Namespace = {};
    for (const arg of this.args) {
      if (arg.action === "store_true") ns[arg.dest] = arg.default ?? false;
      else ns[arg.dest] = arg.default ?? null;
    }

    const positionals: string[] = [];
    let onlyPositionals = false;
    for (let i = 0; i < argv.length; i++) {
      const token = argv[i]!;
      if (onlyPositionals || !token.startsWith("-") || token === "-" || /^-\d/.test(token)) {
        positionals.push(token);
        continue;
      }
      if (token === "--") {
        onlyPositionals = true;
        continue;
      }

      let flag = token;
      let inlineValue: string | null = null;
      const eq = token.indexOf("=");
      if (token.startsWith("--") && eq > 0) {
        flag = token.slice(0, eq);
        inlineValue = token.slice(eq + 1);
      } else if (!token.startsWith("--") && token.length > 2) {
        // Short option with attached value, e.g. -i123
        flag = token.slice(0, 2);
        inlineValue = token.slice(2);
      }

      const arg = this.findOption(flag);
      if (arg.dest === "__help") {
        getIO().stdout(this.formatHelp() + "\n");
        throw new SystemExit(0);
      }
      if (arg.action === "version") {
        getIO().stdout((arg.version ?? "").replace("%(prog)s", this.prog) + "\n");
        throw new SystemExit(0);
      }
      if (arg.action === "store_true") {
        ns[arg.dest] = true;
        continue;
      }

      const value = inlineValue ?? argv[++i];
      if (value === undefined) this.error(`argument ${arg.flags.join("/")}: expected one argument`);
      ns[arg.dest] = this.convert(arg, value);
    }

    // Assign positional arguments in order
    const positionalArgs = this.args.filter((a) => a.positional);
    let index = 0;
    for (let p = 0; p < positionalArgs.length; p++) {
      const arg = positionalArgs[p]!;
      const remainingRequired = positionalArgs.slice(p + 1).filter((a) => a.nargs === undefined || a.nargs === "+").length;
      if (arg.nargs === "+" || arg.nargs === "*") {
        const values = positionals.slice(index, positionals.length - remainingRequired);
        if (arg.nargs === "+" && values.length === 0) this.error(`the following arguments are required: ${arg.dest}`);
        ns[arg.dest] = values.map((v) => this.convert(arg, v));
        index += values.length;
      } else if (arg.nargs === "?") {
        if (positionals.length - index > remainingRequired) ns[arg.dest] = this.convert(arg, positionals[index++]!);
      } else {
        if (index >= positionals.length) this.error(`the following arguments are required: ${arg.dest}`);
        ns[arg.dest] = this.convert(arg, positionals[index++]!);
      }
    }
    if (index < positionals.length) this.error(`unrecognized arguments: ${positionals.slice(index).join(" ")}`);

    delete ns.__help;
    return ns;
  }
}
