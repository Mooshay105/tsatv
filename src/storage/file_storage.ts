/** File based storage module. */

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getLogger } from "../support/logging.ts";
import { pyJsonDumps } from "../support/pyjson.ts";
import { AbstractStorage, StorageModel } from "./index.ts";

const LOGGER = getLogger("pyatv.storage.file_storage");

/** Storage module storing settings in a file. */
export class FileStorage extends AbstractStorage {
  constructor(private readonly _filename: string) {
    super();
  }

  /**
   * Return file storage with default path.
   *
   * This corresponds to the default file storage path that pyatv uses internally,
   * e.g. in atvremote. The path used for this file is $HOME/.pyatv.conf.
   */
  static defaultStorage(): FileStorage {
    return new FileStorage(path.join(os.homedir(), ".pyatv.conf"));
  }

  /** Save settings to active storage. */
  async save(): Promise<void> {
    const dumped = this.toDict();
    if (this.hasChanged(dumped)) {
      LOGGER.debug("Saving settings to %s", this._filename);
      await Bun.write(this._filename, pyJsonDumps(dumped) + "\n");
      this.updateHash(dumped);
    }
  }

  /** Load settings from active storage. */
  async load(): Promise<void> {
    if (existsSync(this._filename)) {
      LOGGER.debug("Loading settings from %s", this._filename);
      const rawData = JSON.parse(await Bun.file(this._filename).text());
      this.storageModel = StorageModel.validate(rawData);

      // Update hash based on what we read from file rather than serializing the
      // model, so that changes caused by validation are detected and saved.
      this.updateHash(rawData);
    }
  }

  override toString(): string {
    return `FileStorage:${this._filename}`;
  }
}
