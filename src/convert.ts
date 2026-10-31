/** Various types of extraction and conversion functions. */

import { DeviceModel, DeviceState, MediaType, Protocol, RepeatState, ShuffleState } from "./const.ts";

function lookup<K>(map: Map<K, string>, key: K, fallback: string): string {
  return map.get(key) ?? fallback;
}

/** Convert internal API device state to string. */
export function deviceStateStr(state: DeviceState | null | undefined): string {
  if (state === null || state === undefined) return "Idle";
  return lookup(
    new Map<number, string>([
      [DeviceState.Idle, "Idle"],
      [DeviceState.Loading, "Loading"],
      [DeviceState.Stopped, "Stopped"],
      [DeviceState.Paused, "Paused"],
      [DeviceState.Playing, "Playing"],
      [DeviceState.Seeking, "Seeking"],
    ]),
    state,
    "Unsupported",
  );
}

/** Convert internal API media type to string. */
export function mediaTypeStr(mediatype: MediaType): string {
  return lookup(
    new Map<number, string>([
      [MediaType.Unknown, "Unknown"],
      [MediaType.Video, "Video"],
      [MediaType.Music, "Music"],
      [MediaType.TV, "TV"],
    ]),
    mediatype,
    "Unsupported",
  );
}

/** Convert internal API repeat state to string. */
export function repeatStr(state: RepeatState): string {
  return lookup(
    new Map<number, string>([
      [RepeatState.Off, "Off"],
      [RepeatState.Track, "Track"],
      [RepeatState.All, "All"],
    ]),
    state,
    "Unsupported",
  );
}

/** Convert internal API shuffle state to string. */
export function shuffleStr(state: ShuffleState): string {
  return lookup(
    new Map<number, string>([
      [ShuffleState.Off, "Off"],
      [ShuffleState.Albums, "Albums"],
      [ShuffleState.Songs, "Songs"],
    ]),
    state,
    "Unsupported",
  );
}

/** Convert internal API protocol to string. */
export function protocolStr(protocol: Protocol): string {
  return lookup(
    new Map<number, string>([
      [Protocol.MRP, "MRP"],
      [Protocol.DMAP, "DMAP"],
      [Protocol.AirPlay, "AirPlay"],
      [Protocol.Companion, "Companion"],
      [Protocol.RAOP, "RAOP"],
    ]),
    protocol,
    "Unknown",
  );
}

/** Convert device model to string. */
export function modelStr(deviceModel: DeviceModel): string {
  return lookup(
    new Map<number, string>([
      [DeviceModel.AppleTVGen1, "Apple TV 1"],
      [DeviceModel.Gen2, "Apple TV 2"],
      [DeviceModel.Gen3, "Apple TV 3"],
      [DeviceModel.Gen4, "Apple TV 4"],
      [DeviceModel.Gen4K, "Apple TV 4K"],
      [DeviceModel.HomePod, "HomePod"],
      [DeviceModel.HomePodMini, "HomePod Mini"],
      [DeviceModel.AirPortExpress, "AirPort Express (gen 1)"],
      [DeviceModel.AirPortExpressGen2, "AirPort Express (gen 2)"],
      [DeviceModel.AppleTV4KGen2, "Apple TV 4K (gen 2)"],
      [DeviceModel.Music, "Music/iTunes"],
      [DeviceModel.AppleTV4KGen3, "Apple TV 4K (gen 3)"],
      [DeviceModel.HomePodGen2, "HomePod (gen 2)"],
      [DeviceModel.HomePodMiniGen2, "HomePod Mini (gen 2)"],
    ]),
    deviceModel,
    "Unknown",
  );
}
