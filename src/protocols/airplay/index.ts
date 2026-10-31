/** Implementation of external API for AirPlay. */

import { existsSync } from "node:fs";
import { AuthenticationType, type HapCredentials, parseCredentials } from "../../auth/hap_pairing.ts";
import { DeviceModel, FeatureName, FeatureState, OperatingSystem, Protocol } from "../../const.ts";
import { Core, MutableService, type SetupData } from "../../core/index.ts";
import type * as mdns from "../../core/mdns.ts";
import { deviceInfoNameFromUniqueShortName, type ScanHandlerDeviceInfoName, type ScanHandlerReturn } from "../../core/scan.ts";
import { HttpError, InvalidConfigError, InvalidCredentialsError, NotSupportedError, ProtocolError } from "../../exceptions.ts";
import { getUniqueId } from "../../helpers.ts";
import {
  type BaseService,
  DeviceInfo,
  FeatureInfo,
  Features,
  type PairingHandler,
  RemoteControl,
  Stream,
} from "../../interface.ts";
import { MrpTunnel } from "../../settings.ts";
import { lookupModel, lookupOs } from "../../support/device_info.ts";
import { type HttpConnection, httpConnect, StaticFileWebServer } from "../../support/http.ts";
import { getLogger } from "../../support/logging.ts";
import * as net from "../../support/net.ts";
import { RtspSession } from "../../support/rtsp.ts";
import { PROTOCOLS, registerProtocol } from "../index.ts";
import * as mrp from "../mrp/index.ts";
import { AirPlayV1 } from "../raop/protocols/airplayv1.ts";
import { AirPlayV2 } from "../raop/protocols/airplayv2.ts";
import { StreamContext, type StreamProtocol } from "../raop/protocols/index.ts";
import { AP2Session } from "./ap2_session.ts";
import { extractCredentials } from "./auth/index.ts";
import { AirPlayMrpConnection } from "./mrp_connection.ts";
import { AirPlayPairingHandler } from "./pairing.ts";
import { AirPlayPlayer } from "./player.ts";
import {
  AirPlayFlags,
  AirPlayMajorVersion,
  getProtocolVersion,
  hasFlag,
  isRemoteControlSupported,
  parseFeatures,
  updateServiceDetails,
} from "./utils.ts";

const LOGGER = getLogger("pyatv.protocols.airplay");

/** Implementation of supported feature functionality. */
export class AirPlayFeatures extends Features {
  constructor(private readonly _features: bigint) {
    super();
  }

  override getFeature(featureName: FeatureName): FeatureInfo {
    if (
      featureName === FeatureName.PlayUrl &&
      (hasFlag(this._features, AirPlayFlags.SupportsAirPlayVideoV1) ||
        hasFlag(this._features, AirPlayFlags.SupportsAirPlayVideoV2))
    ) {
      return new FeatureInfo(FeatureState.Available);
    }
    if (featureName === FeatureName.Stop) return new FeatureInfo(FeatureState.Available);
    return new FeatureInfo(FeatureState.Unavailable);
  }
}

/** Implementation of stream API with AirPlay. */
export class AirPlayStream extends Stream {
  private _playTask: Promise<void> | null = null;
  private _connection: HttpConnection | null = null;

  constructor(readonly core: Core) {
    super();
    // Validate credentials early (raises InvalidCredentialsError)
    parseCredentials(core.service.credentials);
  }

  get config() {
    return this.core.config;
  }

  get service() {
    return this.core.service;
  }

  /** Close and free resources. */
  override close(): void {
    if (this._connection !== null) {
      this._connection.close();
      this._connection = null;
    }
    if (this._playTask !== null) {
      LOGGER.debug("Stopping AirPlay play task");
      this._playTask = null;
    }
  }

  /** Stop current playback. */
  stop(): void {
    this._connection?.close();
  }

  /**
   * Play media from an URL on the device.
   *
   * Note: This method will not return until the media has finished playing.
   */
  override async playUrl(url: string, options: Record<string, unknown> = {}): Promise<void> {
    if (!this.service) throw new NotSupportedError("AirPlay service is not available");

    let server: StaticFileWebServer | null = null;
    let target = url;

    if (existsSync(url)) {
      LOGGER.debug("URL %s is a local file, setting up web server", url);
      const serverAddress = net.getLocalAddressReaching(this.config.address);
      server = new StaticFileWebServer(url, String(serverAddress));
      await server.start();
      target = server.fileAddress;
    }

    const takeoverRelease = this.core.takeover(RemoteControl);
    try {
      // Set up a new connection and wrap it with an AirPlay stream of correct version
      this._connection = await httpConnect(this.config.address, this.service.port);
      // Password protected receivers answer with a digest challenge (pyatv #556)
      this._connection.password = this.service.password ?? null;
      const rtsp = new RtspSession(this._connection);
      const streamProtocol = this.createAirplayProtocol(this.service, rtsp);
      const player = new AirPlayPlayer(rtsp, streamProtocol);
      const position = Math.trunc(Number(options.position ?? 0));
      this._playTask = player.playUrl(target, position);
      return await this._playTask;
    } finally {
      takeoverRelease();
      this._playTask = null;
      if (this._connection) {
        this._connection.close();
        this._connection = null;
      }
      if (server) await server.close();
    }
  }

  /** Create AirPlay protocol implementation based on supported version. */
  createAirplayProtocol(service: BaseService, rtsp: RtspSession): StreamProtocol {
    if (service.protocol !== Protocol.AirPlay) throw new InvalidConfigError("invalid service");

    const context = new StreamContext();
    context.credentials = parseCredentials(service.credentials);
    context.password = service.password ?? null;

    if (getProtocolVersion(service, this.core.settings.protocols.raop.protocol_version) === AirPlayMajorVersion.AirPlayV1) {
      return new AirPlayV1(context, rtsp);
    }
    return new AirPlayV2(context, rtsp);
  }
}

/** Implementation of remote control functionality. */
export class AirPlayRemoteControl extends RemoteControl {
  constructor(readonly stream: AirPlayStream) {
    super();
  }

  override async stop(): Promise<void> {
    this.stream.stop();
  }
}

/** Parse and return a new AirPlay service. */
export function airplayServiceHandler(mdnsService: mdns.Service, _response: mdns.Response): ScanHandlerReturn {
  const service = new MutableService(
    getUniqueId(mdnsService.type, mdnsService.name, mdnsService.properties as any),
    Protocol.AirPlay,
    mdnsService.port,
    mdnsService.properties as any,
  );
  return [mdnsService.name, service];
}

/** Return handlers used for scanning. */
export function scan(): Record<string, ScanHandlerDeviceInfoName> {
  return { "_airplay._tcp.local": [airplayServiceHandler, deviceInfoNameFromUniqueShortName] };
}

function prop(properties: Record<string, string> | Map<string, string>, key: string): string | undefined {
  if (properties instanceof Map) return properties.get(key);
  return Object.prototype.hasOwnProperty.call(properties, key) ? properties[key] : undefined;
}

/** Return device information from zeroconf properties. */
export function deviceInfo(_serviceType: string, properties: Record<string, string> | Map<string, string>): Record<string, unknown> {
  const devinfo: Record<string, unknown> = {};
  const model = prop(properties, "model");
  if (model !== undefined) {
    const lookedUp = lookupModel(model);
    devinfo[DeviceInfo.RAW_MODEL] = model;
    if (lookedUp !== DeviceModel.Unknown) devinfo[DeviceInfo.MODEL] = lookedUp;
    const os = lookupOs(model);
    if (os !== OperatingSystem.Unknown) devinfo[DeviceInfo.OPERATING_SYSTEM] = os;
  }
  const osvers = prop(properties, "osvers");
  if (osvers !== undefined) devinfo[DeviceInfo.VERSION] = osvers;
  const deviceid = prop(properties, "deviceid");
  if (deviceid !== undefined) devinfo[DeviceInfo.MAC] = deviceid;
  const psi = prop(properties, "psi");
  const pi = prop(properties, "pi");
  if (psi !== undefined) devinfo[DeviceInfo.OUTPUT_DEVICE_ID] = psi;
  else if (pi !== undefined) devinfo[DeviceInfo.OUTPUT_DEVICE_ID] = pi;
  return devinfo;
}

/** Update service with additional information. */
export async function serviceInfo(
  service: MutableService,
  _devinfo: DeviceInfo,
  _services: Map<Protocol, BaseService>,
): Promise<void> {
  updateServiceDetails(service);
}

function createMrpTunnelData(core: Core, credentials: HapCredentials): SetupData {
  const session = new AP2Session(
    core.config.address,
    core.service.port,
    credentials,
    core.settings.info,
    core.service.password ?? null,
  );

  // A protocol requires its corresponding service to function, so add a dummy one if
  // we don't have one yet
  let mrpService = core.config.getService(Protocol.MRP);
  if (mrpService === null) {
    mrpService = new MutableService(null, Protocol.MRP, core.service.port, {});
    core.config.addService(mrpService);
  }

  const mrpSetup = mrp.createWithConnection(
    new Core(
      core.config,
      mrpService,
      core.settings,
      core.deviceListener,
      core.sessionManager,
      core.takeover,
      core.stateDispatcher.createCopy(Protocol.MRP),
    ),
    new AirPlayMrpConnection(session, core.deviceListener),
    false, // Already have heartbeat on control channel
  );

  const connectRc = async (): Promise<boolean> => {
    try {
      await session.connect();
      await session.setupRemoteControl();
      session.startKeepAlive(core.deviceListener);
    } catch (ex) {
      if (ex instanceof HttpError && ex.statusCode === 470) {
        throw new InvalidCredentialsError("invalid or missing credentials", { cause: ex });
      }
      if (ex instanceof HttpError) throw ex;
      throw new ProtocolError("Failed to set up remote control channel", { cause: ex });
    }
    await mrpSetup.connect();
    return true;
  };

  const closeRc = (): Set<Promise<unknown>> => {
    const tasks = new Set<Promise<unknown>>();
    for (const t of mrpSetup.close()) tasks.add(t);
    for (const t of session.stop()) tasks.add(t);
    return tasks;
  };

  return {
    protocol: Protocol.MRP,
    connect: connectRc,
    close: closeRc,
    deviceInfo: mrpSetup.deviceInfo,
    interfaces: mrpSetup.interfaces,
    features: mrpSetup.features,
  };
}

/** Set up a new AirPlay service. */
export async function* setup(core: Core): AsyncGenerator<SetupData> {
  // TODO: Split up in connect/protocol and Stream implementation
  const stream = new AirPlayStream(core);

  const features = parseFeatures(prop(core.service.properties, "features") ?? "0x0");
  const credentials = extractCredentials(core.service);

  const interfaces = new Map<unknown, unknown>([
    [Features, new AirPlayFeatures(features)],
    [RemoteControl, new AirPlayRemoteControl(stream)],
    [Stream, stream],
  ]);

  yield {
    protocol: Protocol.AirPlay,
    connect: async () => true,
    close: () => {
      stream.close();
      return new Set();
    },
    deviceInfo: () => deviceInfo(Object.keys(scan())[0]!, core.service.properties),
    interfaces,
    features: new Set([FeatureName.PlayUrl, FeatureName.Stop]),
  };

  // AirPlay 2 does not mandate that a separate RAOP service exists for streaming
  // audio, instead the same service used by AirPlay can be used if a particular flag
  // is set (HasUnifiedAdvertiserInfo).
  if (hasFlag(features, AirPlayFlags.HasUnifiedAdvertiserInfo) && core.config.getService(Protocol.RAOP) === null) {
    LOGGER.debug("RAOP supported but no service present, adding new service");
    const raopService = new MutableService(
      null,
      Protocol.RAOP,
      core.service.port,
      core.service.properties,
      core.service.credentials,
      core.service.password,
    );
    core.config.addService(raopService);

    const raopCore = new Core(
      core.config,
      raopService,
      core.settings,
      core.deviceListener,
      core.sessionManager,
      core.takeover,
      core.stateDispatcher.createCopy(Protocol.RAOP),
    );

    const raop = PROTOCOLS.get(Protocol.RAOP);
    if (raop) yield* raop.setup(raopCore) as any;
  }

  const mrpTunnel = core.settings.protocols.airplay.mrp_tunnel;

  if (mrpTunnel === MrpTunnel.Disable) {
    LOGGER.debug("Remote control tunnel disabled by setting");
  } else if (mrpTunnel === MrpTunnel.Force) {
    LOGGER.debug("Remote control channel is supported (forced)");
    yield createMrpTunnelData(core, credentials);
  } else if (!isRemoteControlSupported(core.service, credentials)) {
    LOGGER.debug("Remote control not supported by device");
  } else if (credentials.type !== AuthenticationType.HAP && credentials.type !== AuthenticationType.Transient) {
    LOGGER.debug("%s not supported by remote control channel", AuthenticationType[credentials.type]);
  } else {
    LOGGER.debug("Remote control channel is supported");
    yield createMrpTunnelData(core, credentials);
  }
}

/** Return pairing handler for protocol. */
export function pair(core: Core, options: Record<string, unknown> = {}): PairingHandler {
  return new AirPlayPairingHandler(core, getProtocolVersion(core.service, core.settings.protocols.raop.protocol_version), options);
}

registerProtocol(Protocol.AirPlay, { setup, scan, pair, deviceInfo, serviceInfo });
