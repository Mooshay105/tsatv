/** Utility methods for parsing various kinds of data. */

import { ProtocolError } from "../../exceptions.ts";

export const DEFAULT_SAMPLE_RATE = 44100;
export const DEFAULT_SAMPLE_SIZE = 16; // bits
export const DEAFULT_CHANNELS = 2;

/** Encryptions supported by receiver (bit flags). */
export enum EncryptionType {
  Unknown = 0,
  Unencrypted = 1,
  RSA = 2,
  FairPlay = 4,
  MFiSAP = 8,
  FairPlaySAPv25 = 16,
}

/** Metadata types supported by receiver (bit flags). */
export enum MetadataType {
  NotSupported = 0,
  Text = 1,
  Artwork = 2,
  Progress = 4,
}

type Props = Record<string, string> | Map<string, string>;

function get(properties: Props, key: string): string | undefined {
  if (properties instanceof Map) return properties.get(key);
  return Object.prototype.hasOwnProperty.call(properties, key) ? properties[key] : undefined;
}

function pyInt(value: string | number): number {
  const text = String(value).trim();
  if (!/^[-+]?\d+$/.test(text)) throw new RangeError(`invalid literal for int(): '${value}'`);
  return parseInt(text, 10);
}

/** Parse Zeroconf properties and return [sample rate, channels, sample size]. */
export function getAudioProperties(properties: Props): [number, number, number] {
  try {
    const sampleRate = pyInt(get(properties, "sr") ?? DEFAULT_SAMPLE_RATE);
    const channels = pyInt(get(properties, "ch") ?? DEAFULT_CHANNELS);
    const sampleSize = Math.trunc(pyInt(get(properties, "ss") ?? DEFAULT_SAMPLE_SIZE) / 8);
    return [sampleRate, channels, sampleSize];
  } catch (ex) {
    throw new ProtocolError("invalid audio property", { cause: ex });
  }
}

/**
 * Return encryption types supported by receiver.
 *
 * Input format from zeroconf is a comma separated list: et=0,1,3
 */
export function getEncryptionTypes(properties: Props): EncryptionType {
  let output = EncryptionType.Unknown;
  let encTypes: number[];
  try {
    const et = get(properties, "et");
    if (et === undefined) return output;
    encTypes = et.split(",").map(pyInt);
  } catch {
    return output;
  }
  const mapping: Record<number, EncryptionType> = {
    0: EncryptionType.Unencrypted,
    1: EncryptionType.RSA,
    3: EncryptionType.FairPlay,
    4: EncryptionType.MFiSAP,
    5: EncryptionType.FairPlaySAPv25,
  };
  for (const encType of encTypes) output |= mapping[encType] ?? EncryptionType.Unknown;
  return output;
}

/**
 * Return metadata types supported by receiver.
 *
 * Input format from zeroconf is comma separated list: md=0,1,2
 */
export function getMetadataTypes(properties: Props): MetadataType {
  let output = MetadataType.NotSupported;
  let mdTypes: number[];
  try {
    const md = get(properties, "md");
    if (md === undefined) return output;
    mdTypes = md.split(",").map(pyInt);
  } catch {
    return output;
  }
  const mapping: Record<number, MetadataType> = { 0: MetadataType.Text, 1: MetadataType.Artwork, 2: MetadataType.Progress };
  for (const mdType of mdTypes) output |= mapping[mdType] ?? MetadataType.NotSupported;
  return output;
}
