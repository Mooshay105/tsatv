#!/usr/bin/env bun
/** CLI application for discovering and controlling Apple TVs. */

import { connect, pair, scan } from "../index.ts";
import { AppleTV, ManualService } from "../conf.ts";
import {
  FeatureName,
  FeatureState,
  InputAction,
  PairingRequirement,
  type PowerState,
  PowerState as PowerStateEnum,
  Protocol,
  RepeatState,
  ShuffleState,
  TouchAction,
  VERSION,
} from "../const.ts";
import { AuthenticationError, NotImplementedError } from "../exceptions.ts";
import * as iface from "../interface.ts";
import { sleep, waitFor } from "../support/asyncio.ts";
import { stringifyModel, updateModelField } from "../support/index.ts";
import { DEBUG, getLogger, INFO, WARNING } from "../support/logging.ts";
import {
  ALL_PROTOCOLS,
  ArgumentTypeError,
  basicConfig,
  createCommonParser,
  formatException,
  getStorage,
  logCurrentVersion,
  type Namespace,
  protocolName,
  SystemExit,
  toCamelCase,
  toSnakeCase,
  transformIdentifiers,
  transformProtocol,
  verifyScanHosts,
  verifyScanProtocols,
} from "./index.ts";
import { eprint, getIO, print } from "./io.ts";

const LOGGER = getLogger("pyatv.scripts.atvremote");

const DEFAULT_TIMEOUT = 10.0;

/** Return commands (snake_case) with help text for a class. */
function commandsOf(cls: object): Record<string, string> {
  return Object.fromEntries(Object.entries(iface.retrieveCommands(cls)).map(([name, doc]) => [toSnakeCase(name), doc]));
}

function printCommands(title: string, api: object): void {
  const cmdList = commandsOf(api);
  const commands =
    " - " +
    Object.entries(cmdList)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, doc]) => `${name} - ${doc}`)
      .join("\n - ");
  print(`${title} commands:\n${commands}\n`);
}

async function readInput(prompt: string): Promise<string> {
  getIO().stdout(prompt);
  return (await getIO().readline()).trim();
}

/** Simple replacement for tabulate (plain text table with headers). */
function tabulate(rows: unknown[][], headers: string[]): string {
  const table = [headers, ...rows.map((row) => row.map((cell) => String(cell)))];
  const widths = headers.map((_, col) => Math.max(...table.map((row) => String(row[col]).length)));
  const numeric = headers.map((_, col) => rows.every((row) => typeof row[col] === "number"));
  const format = (row: unknown[]) =>
    row
      .map((cell, col) => (numeric[col] ? String(cell).padStart(widths[col]!) : String(cell).padEnd(widths[col]!)))
      .join("  ")
      .trimEnd();
  return [format(headers), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(format)].join("\n");
}

async function scanForDevice(
  args: Namespace,
  timeout: number,
  storage: iface.Storage,
  protocol: Protocol | Set<Protocol> | null = null,
): Promise<iface.BaseConfig | null> {
  const options: Parameters<typeof scan>[0] = { timeout, protocol, storage };
  if (!args.name) options.identifier = args.id;
  if (args.scan_hosts) options.hosts = args.scan_hosts;

  const atvs = await scan(options);
  const devices = args.name ? atvs.filter((atv) => atv.name === args.name) : atvs;

  if (atvs.length === 0) {
    LOGGER.error("Could not find any Apple TV on current network");
    return null;
  }

  if (devices.length > 1) {
    LOGGER.error("Found more than one Apple TV; specify one using --id");
    printFoundAppleTvs(devices, eprint);
    return null;
  }

  return devices[0] ?? null;
}

/** Commands not bound to a specific device. */
class GlobalCommands {
  constructor(
    readonly args: Namespace,
    readonly storage: iface.Storage,
  ) {}

  /** Print a list with available commands. */
  async commands(): Promise<number> {
    printCommands("Remote control", iface.RemoteControl);
    printCommands("Metadata", iface.Metadata);
    printCommands("Power", iface.Power);
    printCommands("Playing", iface.Playing);
    printCommands("AirPlay", iface.Stream);
    printCommands("Audio", iface.Audio);
    printCommands("Keyboard", iface.Keyboard);
    printCommands("Device Info", iface.DeviceInfo);
    printCommands("Device", DeviceCommands);
    printCommands("Apps", iface.Apps);
    printCommands("User Accounts", iface.UserAccounts);
    printCommands("Global", GlobalCommands);
    printCommands("Touch", iface.TouchGestures);
    printCommands("Settings", SettingsCommands);
    return 0;
  }

  /** Print help text for a command. */
  async help(): Promise<number> {
    if (this.args.command.length !== 2) {
      eprint("Which command do you want help with?");
      return 1;
    }

    const wanted = this.args.command[1] as string;
    const ifaces: object[] = [
      iface.RemoteControl,
      iface.Metadata,
      iface.Power,
      iface.Playing,
      iface.Stream,
      iface.DeviceInfo,
      iface.Apps,
      iface.Audio,
      iface.Keyboard,
      iface.TouchGestures,
      GlobalCommands,
      DeviceCommands,
    ];
    for (const cls of ifaces) {
      const docs = iface.retrieveCommands(cls);
      for (const [name] of Object.entries(docs)) {
        if (toSnakeCase(name) !== wanted) continue;
        const fullDoc = iface.getCommandDoc(cls, name) ?? docs[name];
        print(`COMMAND:\n>> ${wanted}\n\nHELP:\n${fullDoc}`);
      }
    }
    return 0;
  }

  /** Scan for Apple TVs on the network. */
  async scan(): Promise<number> {
    const atvs = await scan({
      hosts: this.args.scan_hosts,
      timeout: this.args.scan_timeout,
      protocol: this.args.scan_protocols,
      identifier: this.args.id,
      storage: this.storage,
    });
    printFoundAppleTvs(atvs, print);
    return 0;
  }

  /** Pair pyatv as a remote control with an Apple TV. */
  async pair(): Promise<number> {
    if (this.args.protocol === null) {
      LOGGER.error("No protocol specified");
      return 1;
    }

    const conf = this.args.manual ? manualDevice(this.args) : await scanForDevice(this.args, this.args.scan_timeout, this.storage);
    if (!conf) return 2;

    const options: Record<string, unknown> = { name: this.args.remote_name };

    // Inject user provided credentials
    for (const proto of ALL_PROTOCOLS) {
      conf.setCredentials(proto, this.args[`${protocolName(proto)}_credentials`]);
    }

    // Protocol specific options
    if (this.args.protocol === Protocol.DMAP) options.pairingGuid = this.args.pairing_guid;

    const pairing = await pair(conf, this.args.protocol, { storage: this.storage, ...options });

    try {
      await this.performPairing(pairing);
    } catch (ex) {
      LOGGER.error("Pairing failed\n%s", formatException(ex));
      return 3;
    } finally {
      await pairing.close();
    }

    return 0;
  }

  private async performPairing(pairing: iface.PairingHandler): Promise<void> {
    await pairing.begin();

    // Ask for PIN if present or just wait for pairing to end
    if (pairing.deviceProvidesPin) {
      const pin = await readInput("Enter PIN on screen: ");
      pairing.pin(pin);
    } else {
      pairing.pin(this.args.pin_code);

      if (this.args.pin_code === null) {
        print(`Use any pin to pair with "${this.args.remote_name}" (press ENTER to stop)`);
      } else {
        print(`Use pin ${this.args.pin_code} to pair with "${this.args.remote_name}" (press ENTER to stop)`);
      }

      await getIO().readline();
    }

    await pairing.finish();

    // Give some feedback to the user
    if (pairing.hasPaired) {
      print("Pairing seems to have succeeded, yey!");
      print(`You may now use these credentials: ${pairing.service.credentials}`);
    } else {
      print("Pairing failed!");
    }
  }

  /** Wizard to set up a device. */
  async wizard(): Promise<number> {
    print("Looking for devices...");
    const atvs = await scan({ hosts: this.args.scan_hosts, timeout: this.args.scan_timeout, storage: this.storage });
    if (atvs.length === 0) {
      print("No devices found!");
      return 1;
    }

    // Create a list of devices showing index, device name, model and IP address
    const devices = atvs.map((config, index) => [index + 1, config.name, config.deviceInfo.modelStr, config.address]);

    print("Found the following devices:");
    print(tabulate(devices, ["", "Name", "Model", "Address"]));

    let index = 0;
    for (;;) {
      const userInput = await readInput("Enter index of device to set up (q to quit): ");
      if (userInput === "q") return 0;

      if (/^[+-]?\d+$/.test(userInput)) {
        index = parseInt(userInput, 10) - 1;
        if (index >= 0 && index < atvs.length) break;
      }

      eprint("Not a valid device:", userInput);
    }

    const conf = atvs[index]!;
    print(`Starting to set up ${conf.name}`);

    for (const service of conf.services) {
      await this.wizardPassword(service);
      await this.wizardPair(conf, service);
    }

    print("Pairing finished, trying to connect and get some metadata...");

    let atv: iface.AppleTV;
    try {
      atv = await connect(conf, { storage: this.storage });
    } catch (ex) {
      LOGGER.error("Connect failed\n%s", formatException(ex));
      print("Something failed when connecting, error is printed above.");
      return 1;
    }

    print("Currently playing:");
    print(await atv.metadata.playing());
    await Promise.allSettled(atv.close());

    print("Device is now set up!");
    return 0;
  }

  private async wizardPair(conf: iface.BaseConfig, service: iface.BaseService): Promise<void> {
    const name = Protocol[service.protocol];
    if (service.pairing === PairingRequirement.Unsupported) {
      print(`Ignoring ${name} as it is not supported`);
      return;
    }
    if (service.pairing === PairingRequirement.Disabled) {
      print(`
"Protocol ${name} is disabled, please see this page for help:

https://pyatv.dev/support/troubleshooting/#pairing-disabled

This protocol will be ignored for now, but you can just re-run the wizard again
later to pair it.

Press ENTER to continue
`);
      service.credentials = null;
      await getIO().readline();
      return;
    }
    if (service.pairing === PairingRequirement.NotNeeded) {
      print(`Ignoring ${name} since pairing is not needed`);
      service.credentials = null;
      return;
    }

    // Do not pair if we already have credentials
    if (service.credentials) {
      print("Credentials already exists for", name, "=> pairing not needed");
      return;
    }

    print("Starting to pair", `Protocol.${name}`);

    const pairing = await pair(conf, service.protocol, { storage: this.storage });
    try {
      await pairing.begin();

      // Ask for PIN if present or just wait for pairing to end
      if (pairing.deviceProvidesPin) {
        const pin = await readInput("Enter PIN on screen: ");
        pairing.pin(pin);
      } else {
        pairing.pin(1234);
        print(`Use pin 1234 to pair with "${this.args.remote_name}" (press ENTER when you are done)`);
        await getIO().readline();
      }

      await pairing.finish();

      // Give some feedback to the user
      if (pairing.hasPaired) {
        print(`Successfully paired Protocol.${name}, moving on...`);
      } else {
        print("Pairing did not succeed. Press ENTER to continue.");
        await getIO().readline();
      }
    } finally {
      await pairing.close();
    }
  }

  private async wizardPassword(service: iface.BaseService): Promise<void> {
    // Nothing to do if password is not required
    if (!service.requiresPassword) {
      service.password = null;
      return;
    }
    service.password = await readInput(`Please enter password for Protocol.${Protocol[service.protocol]}: `);
  }
}

iface.registerCommands(GlobalCommands, {
  commands: "Print a list with available commands.",
  help: "Print help text for a command.",
  scan: "Scan for Apple TVs on the network.",
  pair: "Pair pyatv as a remote control with an Apple TV.",
  wizard: "Wizard to set up a device.",
});

/**
 * Additional commands available for a device.
 *
 * These commands are not part of the API but are provided by atvremote.
 */
class DeviceCommands {
  constructor(
    readonly atv: iface.AppleTV,
    readonly storage: iface.Storage,
    readonly args: Namespace,
  ) {}

  /** Enter commands in a simple CLI. */
  async cli(): Promise<number> {
    print("Enter commands and press enter");
    print("Type help for help and exit to quit");

    for (;;) {
      const command = await readInput("pyatv> ");
      if (command.toLowerCase() === "exit") break;

      if (command === "cli") {
        print("Command not available here");
        continue;
      }

      await handleDeviceCommand(this.args, command, this.atv, this.storage);
    }
    return 0;
  }

  /** Download artwork and save it to artwork.png. */
  async artworkSave(width: number | null = null, height: number | null = null, fileName = "artwork"): Promise<number> {
    const artwork = await this.atv.metadata.artwork(width, height);
    if (artwork !== null) {
      await Bun.write(`${fileName}.png`, artwork.bytes);
      return 0;
    }
    print("No artwork is currently available.");
    return 1;
  }

  /** Listen for push updates. */
  async pushUpdates(): Promise<number> {
    if (!this.atv.features.inState(FeatureState.Available, FeatureName.PushUpdates)) {
      print("Push updates are not supported (no protocol supports it)");
      return 1;
    }

    print("Press ENTER to stop");

    this.atv.pushUpdater.start();
    await getIO().readline();
    this.atv.pushUpdater.stop();
    return 0;
  }

  /** Print various information about the device. */
  async deviceInfo(): Promise<number> {
    const devinfo = this.atv.deviceInfo;
    print("Model/SW:", devinfo);
    print("     MAC:", devinfo.mac ?? "None");
    return 0;
  }

  /** Print a list of all features and options. */
  async features(): Promise<number> {
    const unsupported = this.args.command.length === 2 && this.args.command[1] === "all";
    const allFeatures = this.atv.features.allFeatures(unsupported);

    print("Feature list:");
    print("-------------");
    for (const [name, feature] of allFeatures) {
      let output = `${FeatureName[name]}: ${FeatureState[feature.state]}`;
      const options = Object.entries(feature.options ?? {}).map(([k, v]) => `${k}=${v}`);
      if (options.length > 0) output += `, Options=${options.join(", ")}`;
      print(output);
    }

    print("\nLegend:");
    print("-------");
    print("Available: Supported by device and usable now");
    print("Unavailable: Supported by device but not usable now");
    print("Unknown: Supported by the device but availability not known");
    print("Unsupported: Not supported by this device (or by pyatv)");
    return 0;
  }

  /** Sleep for a certain amount if milliseconds. */
  async delay(delayTime: number): Promise<number> {
    await sleep(Number(delayTime) / 1000.0);
    return 0;
  }
}

iface.registerCommands(DeviceCommands, {
  cli: "Enter commands in a simple CLI.",
  artworkSave: "Download artwork and save it to artwork.png.",
  pushUpdates: "Listen for push updates.",
  deviceInfo: "Print various information about the device.",
  features: "Print a list of all features and options.",
  delay: "Sleep for a certain amount if milliseconds.",
});

/** Commands to work with settings. */
class SettingsCommands {
  constructor(
    readonly atv: iface.AppleTV,
    readonly storage: iface.Storage,
    readonly args: Namespace,
  ) {}

  /** Print current settings. */
  async printSettings(): Promise<number> {
    print(stringifyModel(this.atv.settings).join("\n"));
    return 0;
  }

  /** Remove current settings. */
  async removeSettings(): Promise<number> {
    await this.storage.removeSettings(this.atv.settings);
    return 0;
  }

  /** Change value of a setting. */
  async changeSetting(setting: string, value: string): Promise<number> {
    updateModelField(this.atv.settings, setting, value);
    return 0;
  }

  /** Unset a setting (make it None). */
  async unsetSetting(setting: string): Promise<number> {
    updateModelField(this.atv.settings, setting, null);
    return 0;
  }
}

iface.registerCommands(SettingsCommands, {
  printSettings: "Print current settings.",
  removeSettings: "Remove current settings.",
  changeSetting: "Change value of a setting.",
  unsetSetting: "Unset a setting (make it None).",
});

/** Internal listener for push updates. */
const pushListener: iface.PushListener = {
  playstatusUpdate(_updater, playstatus) {
    print(String(playstatus));
    print("-".repeat(20));
  },
  playstatusError(_updater, exception) {
    print(`An error occurred (restarting): ${exception}`);
  },
};

/** Listen for power updates and print changes. */
const powerListener: iface.PowerListener = {
  powerstateUpdate(_oldState: PowerState, newState: PowerState) {
    print("New power state:", PowerStateEnum[newState]);
  },
};

/** Internal listener for generic device updates. */
const deviceListener: iface.DeviceListener = {
  connectionLost(exception: Error) {
    eprint("Connection lost, stack trace below:");
    eprint(formatException(exception));
  },
  connectionClosed() {
    LOGGER.debug("Connection was closed properly");
  },
};

function inRange(lower: number, upper: number, allowNone = false) {
  return (value: string): number | null => {
    if (allowNone && value.toLowerCase() === "none") return null;
    const number = Number(value);
    if (Number.isInteger(number) && number >= lower && number < upper) return number;
    throw new ArgumentTypeError(`Must be greater >= ${lower} and < ${upper}`);
  };
}

/** Application starts here. */
async function cliHandler(argv: string[]): Promise<number> {
  const parser = createCommonParser("atvremote");

  parser.addArgument("command", { nargs: "+", help: "commands, help, ..." });
  parser.addArgument("-i", "--id", { help: "device identifier", dest: "id", action: transformIdentifiers, default: null });
  parser.addArgument("-n", "--name", { help: "apple tv name", dest: "name", default: null });
  parser.addArgument("--address", { help: "device ip address or hostname", dest: "address", default: null });
  parser.addArgument("--protocol", { action: transformProtocol, help: "protocol to use (values: dmap, mrp)", dest: "protocol", default: null });
  parser.addArgument("--port", { help: "port when connecting", dest: "port", type: inRange(0, 65535), default: 0 });
  parser.addArgument("-t", "--scan-timeout", {
    help: "timeout when scanning",
    dest: "scan_timeout",
    type: inRange(1, 100),
    metavar: "TIMEOUT",
    default: 3,
  });
  parser.addArgument("-s", "--scan-hosts", { help: "scan specific hosts", dest: "scan_hosts", default: null, action: verifyScanHosts });
  parser.addArgument("--scan-protocols", {
    help: "scan for specific protocols",
    dest: "scan_protocols",
    default: null,
    action: verifyScanProtocols,
  });
  parser.addArgument("--version", { action: "version", help: "version of atvremote and pyatv", version: `%(prog)s ${VERSION}` });

  const pairingGroup = parser.addArgumentGroup("pairing");
  pairingGroup.addArgument("--remote-name", { help: "remote pairing name", dest: "remote_name", default: "pyatv" });
  pairingGroup.addArgument("-p", "--pin", {
    help: "pairing pin code",
    dest: "pin_code",
    metavar: "PIN",
    default: 1234,
    type: inRange(0, 9999, true),
  });
  pairingGroup.addArgument("--pairing-guid", { help: "pairing guid (16 chars hex)", dest: "pairing_guid", default: null });

  parser.addArgument("-m", "--manual", { action: "store_true", help: "use manual device details", dest: "manual", default: false });
  parser.addArgument("--service-properties", { dest: "service_properties", default: "", help: "manual MDNS properties" });

  const creds = parser.addArgumentGroup("credentials");
  for (const prot of ALL_PROTOCOLS) {
    creds.addArgument(`--${protocolName(prot)}-credentials`, {
      help: `credentials for ${Protocol[prot]}`,
      dest: `${protocolName(prot)}_credentials`,
      default: null,
    });
  }

  const passwords = parser.addArgumentGroup("passwords");
  for (const prot of [Protocol.AirPlay, Protocol.RAOP]) {
    passwords.addArgument(`--${protocolName(prot)}-password`, {
      help: `password for ${Protocol[prot]}`,
      dest: `${protocolName(prot)}_password`,
      default: null,
    });
  }

  const debug = parser.addArgumentGroup("debugging");
  debug.addArgument("-v", "--verbose", { help: "increase output verbosity", action: "store_true", dest: "verbose" });
  debug.addArgument("--debug", { help: "print debug information", action: "store_true", dest: "debug" });
  debug.addArgument("--mdns-debug", { help: "print mdns debug data", action: "store_true", dest: "mdns_debug" });

  const args = parser.parseArgs(argv);
  if (args.manual && args.id instanceof Set) parser.error("--manual only supports one identifier to --id");
  if (!args.manual && args.service_properties) parser.error("--service-properties only allowed with --manual");

  let loglevel = WARNING;
  if (args.verbose) loglevel = INFO;
  if (args.debug) loglevel = DEBUG;
  const removeHandler = basicConfig(loglevel);

  try {
    logCurrentVersion();

    if (args.mdns_debug) getLogger("pyatv.core.mdns").setLevel(DEBUG);

    const cmds = iface.retrieveCommands(GlobalCommands);

    const storage = getStorage(args);
    await storage.load();

    try {
      const firstCommand = toCamelCase(args.command[0]);
      if (firstCommand in cmds) {
        const globCmds = new GlobalCommands(args, storage);
        return (await execCommand(globCmds, firstCommand, false)) as number;
      }
      if (!args.manual) {
        const config = await autodiscoverDevice(args, storage);
        if (!config) return 1;
        return await handleCommands(args, config, storage);
      }

      if (args.port === 0 || args.address === null || args.protocol === null) {
        LOGGER.error("You must specify address, port and protocol in manual mode");
        return 1;
      }

      return await handleCommands(args, manualDevice(args), storage);
    } finally {
      await storage.save();
    }
  } finally {
    removeHandler();
  }
}

function printFoundAppleTvs(atvs: iface.BaseConfig[], output: (...values: unknown[]) => void): void {
  output("Scan Results");
  output("=".repeat(40));
  for (const appleTv of atvs) output(`${appleTv}\n`);
}

async function autodiscoverDevice(args: Namespace, storage: iface.Storage): Promise<iface.BaseConfig | null> {
  const appleTv = await scanForDevice(args, args.scan_timeout, storage, args.scan_protocols);
  if (!appleTv) return null;

  const setField = (protocol: Protocol, field: string, attribute: "credentials" | "password") => {
    const service = appleTv.getService(protocol);
    if (service) {
      // If "" is specified, unset the field (null)
      const argValue = args[field];
      service[attribute] = argValue === "" ? null : argValue || service[attribute];
    }
  };

  for (const proto of ALL_PROTOCOLS) setField(proto, `${protocolName(proto)}_credentials`, "credentials");
  for (const proto of [Protocol.RAOP, Protocol.AirPlay]) setField(proto, `${protocolName(proto)}_password`, "password");

  LOGGER.info("Auto-discovered %s at %s", appleTv.name, appleTv.address);
  return appleTv;
}

function manualDevice(args: Namespace): AppleTV {
  let properties: Record<string, string> = {};
  if (args.service_properties) {
    // Service properties are specified according to Xvar1=val1Xvar2=var2" where X is
    // any character not in any variable or value. Examples would be
    // ":name=test:type=something" or ",name=test,type=something" (both are equal). No
    // proper error checking here!
    const splitChar = args.service_properties[0];
    properties = Object.fromEntries(
      (args.service_properties as string)
        .slice(1)
        .split(splitChar)
        .map((v) => {
          const index = v.indexOf("=");
          return [v.slice(0, index), v.slice(index + 1)];
        }),
    );
  }

  const config = new AppleTV(args.address, args.name);
  const service = new ManualService(args.id, args.protocol, args.port, properties);
  service.credentials = args[`${protocolName(args.protocol)}_credentials`];
  if (args.protocol === Protocol.AirPlay) service.password = args.airplay_password;
  else if (args.protocol === Protocol.RAOP) service.password = args.raop_password;
  config.addService(service);
  return config;
}

function enumValue<T extends number>(enumObj: Record<string, string | number>, name: string, value: unknown): T {
  if (typeof value !== "number" || !(value in enumObj)) throw new Error(`${value} is not a valid ${name}`);
  return value as T;
}

/**
 * Parse input command with arguments.
 *
 * Parses the input command in such a way that the user may provide additional argument
 * to the command. The format used is this: command=arg1,arg2,arg3,... All the
 * additional arguments are passed as arguments to the target method.
 */
export function extractCommandWithArgs(cmd: string): [string, unknown[]] {
  const typeparse = (value: string): unknown => {
    // Special case where input is forced to be treated as a string by quoting
    if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
    return /^\s*[+-]?\d+\s*$/.test(value) ? parseInt(value, 10) : value;
  };

  const parseArgs = (command: string, rawArgs: string[]): unknown[] => {
    const args = rawArgs.map(typeparse);
    if (command === "set_shuffle") return [enumValue(ShuffleState, "ShuffleState", args[0])];
    if (command === "set_repeat") return [enumValue(RepeatState, "RepeatState", args[0])];
    if (["up", "down", "left", "right", "select", "menu", "home", "click"].includes(command)) {
      return [enumValue(InputAction, "InputAction", args[0])];
    }
    if (command === "set_volume") return [parseFloat(String(args[0]))];
    if (command === "action") return [args[0], args[1], enumValue(TouchAction, "TouchAction", args[2])];
    return args;
  };

  const equalSign = cmd.indexOf("=");
  if (equalSign === -1) return [cmd, []];

  const command = cmd.slice(0, equalSign);
  return [command, parseArgs(command, cmd.slice(equalSign + 1).split(","))];
}

async function handleCommands(args: Namespace, config: iface.BaseConfig, storage: iface.Storage): Promise<number> {
  const atv = await connect(config, { protocol: args.protocol, storage });
  atv.listener = deviceListener;
  atv.power.listener = powerListener;

  if (atv.features.inState(FeatureState.Available, FeatureName.PushUpdates)) {
    atv.pushUpdater.listener = pushListener;
  } else {
    print("NOTE: Push updates are not supported in this configuration");
  }

  try {
    for (const cmd of args.command) {
      const ret = await handleDeviceCommand(args, cmd, atv, storage);
      if (ret !== 0) return ret;
    }
  } finally {
    const remainingTasks = atv.close();
    LOGGER.debug("Waiting for %d remaining tasks", remainingTasks.size);
    await waitFor(Promise.allSettled(remainingTasks), DEFAULT_TIMEOUT);
  }
  return 0;
}

async function handleDeviceCommand(args: Namespace, rawCmd: string, atv: iface.AppleTV, storage: iface.Storage): Promise<number> {
  // Parse input command and argument from user
  const [snakeCmd, cmdArgs] = extractCommandWithArgs(rawCmd);
  const cmd = toCamelCase(snakeCmd);
  const has = (cls: object) => cmd in iface.retrieveCommands(cls);

  if (has(DeviceCommands)) return (await execCommand(new DeviceCommands(atv, storage, args), cmd, false, ...cmdArgs)) as number;
  if (has(SettingsCommands)) return (await execCommand(new SettingsCommands(atv, storage, args), cmd, false, ...cmdArgs)) as number;

  // NB: Needs to be above RemoteControl for now as volume_up/down exists in both but
  // implementations in Audio shall be called
  if (has(iface.Audio)) return execCommand(atv.audio, cmd, true, ...cmdArgs);
  if (has(iface.RemoteControl)) return execCommand(atv.remoteControl, cmd, true, ...cmdArgs);
  if (has(iface.Metadata)) return execCommand(atv.metadata, cmd, true, ...cmdArgs);
  if (has(iface.Power)) return execCommand(atv.power, cmd, true, ...cmdArgs);
  if (has(iface.Playing)) return execCommand(await atv.metadata.playing(), cmd, true, ...cmdArgs);
  if (has(iface.Stream)) return execCommand(atv.stream, cmd, true, ...cmdArgs);
  if (has(iface.Keyboard)) return execCommand(atv.keyboard, cmd, true, ...cmdArgs);
  if (has(iface.DeviceInfo)) return execCommand(atv.deviceInfo, cmd, true, ...cmdArgs);
  if (has(iface.Apps)) return execCommand(atv.apps, cmd, true, ...cmdArgs);
  if (has(iface.UserAccounts)) return execCommand(atv.userAccounts, cmd, true, ...cmdArgs);
  if (has(iface.TouchGestures)) return execCommand(atv.touch, cmd, true, ...cmdArgs);

  LOGGER.error("Unknown command: %s", snakeCmd);
  return 1;
}

async function execCommand(obj: any, command: string, printResult: boolean, ...args: unknown[]): Promise<any> {
  try {
    // If the command to execute is a property, the value returned by that property is
    // used. Otherwise it's a method and we have to wait for the result.
    const tmp = obj[command];
    let value: unknown;
    if (typeof tmp === "function") {
      // Special case for stream_file: if - is passed as input file, use stdin as source
      // instead of passing filename
      if (command === "streamFile" && args[0] === "-") args = [getIO().stdinStream(), ...args.slice(1)];
      value = await tmp.apply(obj, args);
    } else {
      value = tmp;
    }

    // Some commands might produce output themselves (especially non-API commands), so
    // don't print the return code they might give
    if (printResult) {
      prettyPrint(value);
      return 0;
    }
    return value;
  } catch (ex) {
    if (ex instanceof NotImplementedError) {
      LOGGER.error("Command '%s' is not supported by device\n%s", toSnakeCase(command), formatException(ex));
    } else if (ex instanceof AuthenticationError) {
      LOGGER.error("Authentication error: %s\n%s", ex.message, formatException(ex));
    } else {
      throw ex;
    }
  }
  return 1;
}

function prettyPrint(data: unknown): void {
  if (data === null || data === undefined) return;
  if (Buffer.isBuffer(data)) print(data.toString("hex"));
  else if (Array.isArray(data)) print(data.map((item) => String(item)).join(", "));
  else print(data);
}

/** Run the application and return exit code. */
export async function appstart(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    return await cliHandler(argv);
  } catch (ex) {
    if (ex instanceof SystemExit) return 1; // sys.exit() was used - do nothing (same as pyatv)
    eprint(formatException(ex));
    getIO().stderr("\n>>> An error occurred, full stack trace above\n");
  }
  return 1;
}

if (import.meta.main) {
  process.exit(await appstart());
}
