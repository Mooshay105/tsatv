/** Support for working with NSKeyedArchiver serialized data. */

import * as plistlib from "../../support/plistlib.ts";

/**
 * Get properties from NSKeyedArchiver encoded PList.
 *
 * In the absence of a robust NSKeyedArchiver implementation, read one or more
 * properties from the archived plist by following UID references.
 */
export function readArchiveProperties(archive: Uint8Array, ...paths: string[][]): unknown[] {
  const data = plistlib.loads(Buffer.from(archive)) as Record<string, any>;
  const objects = data.$objects as unknown[];
  const results: unknown[] = [];

  for (const path of paths) {
    let element: any = data.$top;
    let found = true;
    for (const key of path) {
      if (element === null || element === undefined || typeof element !== "object" || !(key in element)) {
        found = false;
        break;
      }
      element = element[key];
      if (element instanceof plistlib.UID) {
        if (element.data >= objects.length) {
          found = false;
          break;
        }
        element = objects[element.data];
      }
    }
    results.push(found ? element : null);
  }
  return results;
}
