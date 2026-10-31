/** State producer module. */

export const NO_MAX_CALLS = 0;

const noop = () => undefined;

/**
 * Base class for objects announcing state changes to a listener.
 *
 * The listener property returns a proxy that allows calling functions in the
 * listener. If no listener is set, a null-function (doing nothing) is returned so
 * that nothing happens. This makes it safe to call functions without having to
 * check if either a listener has been set at all or if the listener implements the
 * called function.
 *
 * Unlike pyatv (which uses a weakref), the listener is held by a normal reference:
 * JavaScript has no reference counting so cycles are not a problem, and with a weak
 * reference an inline listener (`atv.listener = { ... }`) would silently stop
 * receiving updates whenever the garbage collector runs.
 */
export class StateProducer<StateListener extends object = any> {
  private _listener: StateListener | null = null;
  maxCalls: number;
  callsMade = 0;

  constructor(maxCalls: number = NO_MAX_CALLS) {
    this.maxCalls = maxCalls;
  }

  /** Return current listener object (as a safe proxy). */
  get listener(): StateListener {
    const producerRef = new WeakRef(this);
    const listenerObj = this._listener;
    return new Proxy({} as StateListener, {
      get: (_target, attr) => {
        const producer = producerRef.deref();

        if (producer) {
          // Count number of calls to _any_ method and if total count exceeds the
          // given max limit, then bail out
          producer.callsMade += 1;
          if (producer.maxCalls && producer.callsMade > producer.maxCalls) {
            return noop;
          }
        }

        if (listenerObj !== null) {
          const listener = listenerObj as any;
          if (attr in listener) {
            producer?.stateWasUpdated();
            const value = listener[attr];
            return typeof value === "function" ? value.bind(listener) : value;
          }
        } else {
          // If no listener is set, still announce that state was changed. Setting
          // a listener is optional but the outcome of announcing a new state is still
          // likely expected to be the same no matter if a listener is set or not.
          producer?.stateWasUpdated();
        }

        return noop;
      },
    });
  }

  /** Change current listener object. Set to null to remove active listener. */
  set listener(target: StateListener | null | undefined) {
    this._listener = target ?? null;
  }

  /** Return the actual listener object (not a proxy) or null. */
  get rawListener(): StateListener | null {
    return this._listener;
  }

  /** Call when state was updated. */
  stateWasUpdated(): void {}
}
