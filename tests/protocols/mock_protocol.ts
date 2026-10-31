/**
 * Implementation of a protocol in mocked version for testing.
 *
 * This module allows for mocking protocols in pyatv.protocols and is meant for testing
 * core features. It is not complete, just implemented enough to work. More fine grained
 * functionality can be added over time as needed.
 */

import { mock } from "bun:test";
import type { Protocol } from "../../src/const.ts";
import type { Core, SetupData } from "../../src/core/index.ts";
import type { PairingHandler } from "../../src/interface.ts";
import { PROTOCOLS, type ProtocolMethods } from "../../src/protocols/index.ts";

export class MockedProtocol {
  readonly pairMock = {} as PairingHandler;
  readonly setupMock = {
    connect: mock(async () => true),
    close: mock(() => new Set<Promise<unknown>>()),
    deviceInfo: mock(() => ({})),
    interfaces: new Map<unknown, unknown>(),
    features: new Set(),
  };
  core: Core | null = null;

  constructor(private readonly protocol: Protocol) {}

  get methods(): ProtocolMethods {
    return {
      setup: (core) => this.setup(core),
      scan: () => ({}),
      pair: (core) => {
        this.core = core;
        return this.pairMock;
      },
      deviceInfo: () => ({}),
      serviceInfo: async () => {},
    };
  }

  /** Set up a new protocol service. */
  *setup(core: Core): Generator<SetupData> {
    this.core = core;
    yield {
      protocol: this.protocol,
      connect: this.setupMock.connect,
      close: this.setupMock.close,
      deviceInfo: this.setupMock.deviceInfo,
      interfaces: this.setupMock.interfaces,
      features: this.setupMock.features as SetupData["features"],
    };
  }
}

/** Replace all protocols with a mocked version of a protocol while running fn. */
export async function mockProtocol<T>(protocol: Protocol, fn: (mocked: MockedProtocol) => Promise<T>): Promise<T> {
  const mocked = new MockedProtocol(protocol);
  const saved = new Map(PROTOCOLS);
  PROTOCOLS.clear();
  PROTOCOLS.set(protocol, mocked.methods);
  try {
    return await fn(mocked);
  } finally {
    PROTOCOLS.clear();
    for (const [key, value] of saved) PROTOCOLS.set(key, value);
  }
}
