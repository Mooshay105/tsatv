/** State producer module. */

export const NO_MAX_CALLS = 0;

const noop = () => undefined;

/**
 * Base class for objects announcing state changes to a listener.
 *
 * The listener property returns a proxy that maintains a weak reference to the
 * listener object and allows calling functions in the listener. If no listener is
 * set or the weak reference has expired, a null-function (doing nothing) is returned
 * so that nothing happens. This makes it safe to call functions without having to
 * check if either a listener has been set at all or if the listener implements the
 * called function.
 */
export class StateProducer<StateListener extends object = any> {
  private _listenerRef: WeakRef<StateListener> | null = null;
  maxCalls: number;
  callsMade = 0;

  constructor(maxCalls: number = NO_MAX_CALLS) {
    this.maxCalls = maxCalls;
  }

  /** Return current listener object (as a safe proxy). */
  get listener(): StateListener {
    const producerRef = new WeakRef(this);
    const listenerRef = this._listenerRef;
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

        if (listenerRef !== null) {
          const listener = listenerRef.deref() as any;
          if (listener && attr in listener) {
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
    this._listenerRef = target ? new WeakRef(target) : null;
  }

  /** Return the actual listener object (not a proxy) or null. */
  get rawListener(): StateListener | null {
    return this._listenerRef?.deref() ?? null;
  }

  /** Call when state was updated. */
  stateWasUpdated(): void {}
}
