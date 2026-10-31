/**
 * Relay method calls to interfaces of multiple implementations.
 *
 * A Relayer instance keeps track of multiple implementations of an interface and
 * forwards method calls to one of the instances based on a priority list. If no
 * instance provides an implementation (i.e. overrides the method in the base
 * interface), NotSupportedError is raised.
 */

import { Protocol } from "../const.ts";
import { InvalidStateError, NotSupportedError } from "../exceptions.ts";

type Constructor = { prototype: object };

/** Find property descriptor in prototype chain. */
function findDescriptor(obj: object | null, name: string): PropertyDescriptor | undefined {
  let current = obj;
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) return descriptor;
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

function implementationOf(descriptor: PropertyDescriptor | undefined): unknown {
  if (!descriptor) return undefined;
  return descriptor.get ?? descriptor.value;
}

/** Relay method calls to instances based on priority. */
export class Relayer<T extends object = any> {
  private readonly _interfaces = new Map<Protocol, T>();
  private _takeoverProtocol: Protocol[] = [];

  constructor(
    private readonly _baseInterface: Constructor,
    private readonly _priorities: Protocol[],
  ) {}

  /** Return number of registered instances. */
  get count(): number {
    return this._interfaces.size;
  }

  /** Return main instance based on priority. */
  get mainInstance(): T {
    for (const priority of [...this._takeoverProtocol, ...this._priorities]) {
      const instance = this._interfaces.get(priority);
      if (instance !== undefined) return instance;
    }
    throw new NotSupportedError();
  }

  /** Return Protocol for main instance. */
  get mainProtocol(): Protocol | null {
    for (const priority of [...this._takeoverProtocol, ...this._priorities]) {
      if (this._interfaces.has(priority)) return priority;
    }
    return null;
  }

  /** Return all instances added to this relayer. */
  get instances(): T[] {
    return [...this._interfaces.values()];
  }

  /** Register a new instance for an interface. */
  register(instance: T, protocol: Protocol): void {
    if (!this._priorities.includes(protocol)) {
      throw new Error(`${Protocol[protocol]} not in priority list`);
    }
    this._interfaces.set(protocol, instance);
  }

  /** Return instance for protocol if available. */
  get(protocol: Protocol): T | null {
    return this._interfaces.get(protocol) ?? null;
  }

  /**
   * Return method (bound to instance) or property value of target instance.
   *
   * Methods are returned bound so they can be called directly.
   */
  relay(target: string, priority: Protocol[] | null = null): any {
    const instance = this._findInstance(target, [...this._takeoverProtocol, ...(priority ?? this._priorities)]);
    const value = (instance as any)[target];
    return typeof value === "function" ? value.bind(instance) : value;
  }

  private _findInstance(target: string, priority: Protocol[]): T {
    const base = implementationOf(findDescriptor(this._baseInterface.prototype, target));
    for (const priorityIface of priority) {
      const iface = this._interfaces.get(priorityIface);

      // Interface defined in priority list but no instance for that interface are
      // just ignored as no implementation probably exists
      if (!iface) continue;

      // Trying to call a method not in the target interface
      const relayTarget = implementationOf(findDescriptor(Object.getPrototypeOf(iface), target));
      if (relayTarget === undefined) {
        throw new Error(`${target} not in ${Protocol[priorityIface]}`);
      }

      // Method must be overridden in base interface
      if (relayTarget !== base) return iface;
    }

    // An existing method not implemented by any instance is "not supported"
    throw new NotSupportedError(`${target} is not supported`);
  }

  /** Temporary override priority list with a specific protocol. */
  takeover(protocol: Protocol): void {
    if (this._takeoverProtocol.length > 0) {
      throw new InvalidStateError(`${Protocol[this._takeoverProtocol[0]!]} has already done takeover`);
    }
    this._takeoverProtocol = [protocol];
  }

  /** Release temporary takeover. */
  release(): void {
    this._takeoverProtocol = [];
  }
}
