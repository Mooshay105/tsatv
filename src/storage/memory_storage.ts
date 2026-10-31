/** Memory storage module. */

import { AbstractStorage } from "./index.ts";

/**
 * Memory based storage module.
 *
 * Everything stored with it will be forgotten when the process exits.
 */
export class MemoryStorage extends AbstractStorage {
  /** Save settings to active storage. */
  async save(): Promise<void> {
    this.updateHash(this.toDict());
  }

  /** Load settings from active storage. */
  async load(): Promise<void> {}

  override toString(): string {
    return "MemoryStorage";
  }
}
