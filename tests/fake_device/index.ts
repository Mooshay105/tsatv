/** Representation of a fake device supporting multiple protocol. */

import type { Protocol } from "../../src/const.ts";
import { WebApp } from "./web.ts";

export interface FakeServiceImpl {
  readonly port: number;
  start(startWebServer: boolean): Promise<void>;
  cleanup(): Promise<void>;
}

export type ServiceFactory = (state: any, app: WebApp) => FakeServiceImpl;
export type StateFactory = (options: any) => any;
export type UsecaseFactory = (state: any) => any;

export const FACTORIES = new Map<Protocol, [ServiceFactory, StateFactory, UsecaseFactory]>();

/** Register factories for a fake protocol implementation. */
export function registerFake(protocol: Protocol, service: ServiceFactory, state: StateFactory, usecase: UsecaseFactory): void {
  FACTORIES.set(protocol, [service, state, usecase]);
}

export interface FakeService {
  service: FakeServiceImpl;
  state: any;
  usecase: any;
}

/**
 * Fake Apple TV hosting one or more fake protocol services.
 *
 * In test mode, HTTP based services share a common web application (see `app`).
 */
export class FakeAppleTV {
  readonly services = new Map<Protocol, FakeService>();
  readonly app: WebApp | null;
  private _hasStarted = false;

  constructor(readonly testMode = true) {
    this.app = testMode ? new WebApp() : null;
  }

  /** Port of shared web application (test mode only). */
  get serverPort(): number {
    return this.app!.port;
  }

  async start(): Promise<void> {
    if (this._hasStarted) return;
    for (const service of this.services.values()) await service.service.start(!this.testMode);
    if (this.app && !this.app.running) await this.app.start();
    this._hasStarted = true;
  }

  async stop(): Promise<void> {
    for (const service of this.services.values()) await service.service.cleanup();
    await this.app?.stop();
    this._hasStarted = false;
  }

  addService<S = any, U = any>(protocol: Protocol, options: Record<string, unknown> = {}): [S, U] {
    const factories = FACTORIES.get(protocol);
    if (!factories) throw new Error(`no fake implementation for protocol ${protocol}`);
    const [serviceFactory, stateFactory, usecaseFactory] = factories;
    const state = stateFactory(options);
    const service = serviceFactory(state, this.testMode ? this.app! : new WebApp());
    const usecase = usecaseFactory(state);
    this.services.set(protocol, { service, state, usecase });
    return [state, usecase];
  }

  getPort(protocol: Protocol): number {
    return this.services.get(protocol)!.service.port;
  }

  getState<S = any>(protocol: Protocol): S {
    return this.services.get(protocol)!.state;
  }

  getUsecase<U = any>(protocol: Protocol): U {
    return this.services.get(protocol)!.usecase;
  }
}
