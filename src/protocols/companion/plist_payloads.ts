/**
 * Helper function to generate payloads for RTI service.
 *
 * In the absence of a robust NSKeyedArchiver implementation, these are pre-encoded.
 */

import * as plistlib from "../../support/plistlib.ts";

const { UID } = plistlib;

const archive = (objects: unknown[]): Buffer =>
  plistlib.dumps(
    {
      $version: 100000,
      $archiver: "RTIKeyedArchiver",
      $top: { textOperations: new UID(1) },
      $objects: objects,
    },
    { fmt: plistlib.PlistFormat.BINARY, sortKeys: false },
  );

const classInfo = (name: string) => ({ $classname: name, $classes: [name, "NSObject"] });

/** Prepare an NSKeyedArchiver encoded payload for clearing the RTI text. */
export function getRtiClearTextPayload(sessionUuid: Uint8Array): Buffer {
  return archive([
    "$null",
    {
      $class: new UID(7),
      targetSessionUUID: new UID(5),
      keyboardOutput: new UID(2),
      textToAssert: new UID(4),
    },
    { $class: new UID(3) },
    classInfo("TIKeyboardOutput"),
    "",
    { "NS.uuidbytes": Buffer.from(sessionUuid), $class: new UID(6) },
    classInfo("NSUUID"),
    classInfo("RTITextOperations"),
  ]);
}

/** Prepare an NSKeyedArchiver encoded payload for RTI text input. */
export function getRtiInputTextPayload(sessionUuid: Uint8Array, text: string): Buffer {
  return archive([
    "$null",
    {
      keyboardOutput: new UID(2),
      $class: new UID(7),
      targetSessionUUID: new UID(5),
    },
    { insertionText: new UID(3), $class: new UID(4) },
    text,
    classInfo("TIKeyboardOutput"),
    { "NS.uuidbytes": Buffer.from(sessionUuid), $class: new UID(6) },
    classInfo("NSUUID"),
    classInfo("RTITextOperations"),
  ]);
}
