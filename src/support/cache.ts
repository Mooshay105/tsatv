/** Simple LRU cache for data based on an identifier. */

export class Cache<K = string, V = unknown> {
  readonly data = new Map<K, V>();

  constructor(public limit = 16) {}

  /** Return if cache is empty or not. */
  empty(): boolean {
    return this.data.size === 0;
  }

  /** Put something in the cache. */
  put(identifier: K, data: V): void {
    if (this.data.has(identifier)) {
      this.data.delete(identifier);
    } else if (this.data.size >= this.limit) {
      const oldest = this.data.keys().next().value as K;
      this.data.delete(oldest);
    }
    this.data.set(identifier, data);
  }

  /** Get something from the cache. Throws if missing. */
  get(identifier: K): V {
    if (!this.data.has(identifier)) {
      throw new Error(`KeyError: ${String(identifier)}`);
    }
    const value = this.data.get(identifier) as V;
    this.data.delete(identifier);
    this.data.set(identifier, value);
    return value;
  }

  /** Return identifier of last recently used identifier. */
  latest(): K | null {
    if (this.empty()) return null;
    let last: K | null = null;
    for (const key of this.data.keys()) last = key;
    return last;
  }

  has(identifier: K): boolean {
    return this.data.has(identifier);
  }

  get size(): number {
    return this.data.size;
  }
}
