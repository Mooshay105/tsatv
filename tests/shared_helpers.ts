/** Shared test helper code. */

import type { PowerState } from "../src/const.ts";
import type { PowerListener } from "../src/interface.ts";

export class SavingPowerListener implements PowerListener {
  lastUpdate: PowerState | null = null;
  allUpdates: PowerState[] = [];

  powerstateUpdate(_oldState: PowerState, newState: PowerState): void {
    this.lastUpdate = newState;
    this.allUpdates.push(newState);
  }
}
