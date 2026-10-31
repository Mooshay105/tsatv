import { NotImplementedError } from "../../exceptions.ts";

/**
 * Simple FIFO for packets based on Map.
 *
 * This FIFO holds a certain number of elements as defined by upperLimit. Each item maps
 * a sequence number to a packet, allowing fast look up of a certain packet. The order is
 * defined by insertion order and *not* sequence number order.
 *
 * When upper limit is exceeded, the item that was *inserted* first, is removed.
 */
export class PacketFifo<T> {
  private readonly _items = new Map<number, T>();

  constructor(private readonly _upperLimit: number) {}

  /** Remove all items in FIFO. */
  clear(): void {
    this._items.clear();
  }

  /** Number of items in FIFO. */
  get size(): number {
    return this._items.size;
  }

  /** Add an item to FIFO. */
  set(index: number, value: T): void {
    if (!Number.isInteger(index)) throw new TypeError("only int supported as key");

    // Cannot add item with same index again
    if (this._items.has(index)) throw new RangeError(`${index} already in FIFO`);

    // Remove oldest item if limit is exceeded
    if (this._items.size + 1 > this._upperLimit) {
      this._items.delete(this._items.keys().next().value!);
    }
    this._items.set(index, value);
  }

  /** Return value of an item. */
  get(index: number): T {
    if (!Number.isInteger(index)) throw new TypeError("only int supported as key");
    if (!this._items.has(index)) throw new RangeError(`${index} not in FIFO`);
    return this._items.get(index)!;
  }

  /** Return if an element exists in FIFO. */
  has(index: number): boolean {
    return this._items.has(index);
  }

  /** Removing items is not supported. */
  delete(_index: number): never {
    throw new NotImplementedError("removing items not supported");
  }

  /** Iterate over indices in FIFO. */
  [Symbol.iterator](): IterableIterator<number> {
    return this._items.keys();
  }

  keys(): IterableIterator<number> {
    return this._items.keys();
  }

  /**
   * Return string representation of FIFO.
   *
   * Only index numbers are returned in the string.
   */
  toString(): string {
    return `[${[...this._items.keys()].join(", ")}]`;
  }

  /** Return internal representation as string of FIFO. */
  repr(): string {
    return `{${[...this._items].map(([k, v]) => `${k}: ${v}`).join(", ")}}`;
  }
}
