import { expect, test } from "bun:test";
import * as convert from "../src/convert.ts";
import { DeviceModel, DeviceState, MediaType, Protocol, RepeatState, ShuffleState } from "../src/const.ts";

test.each([
  [MediaType.Unknown, "Unknown"],
  [MediaType.Video, "Video"],
  [MediaType.Music, "Music"],
  [MediaType.TV, "TV"],
  [99, "Unsupported"],
])("media type %p", (value, output) => expect(convert.mediaTypeStr(value)).toBe(output));

test.each([
  [DeviceState.Idle, "Idle"],
  [DeviceState.Loading, "Loading"],
  [DeviceState.Stopped, "Stopped"],
  [DeviceState.Paused, "Paused"],
  [DeviceState.Playing, "Playing"],
  [DeviceState.Seeking, "Seeking"],
  [999, "Unsupported"],
])("device state %p", (value, output) => expect(convert.deviceStateStr(value)).toBe(output));

test.each([
  [RepeatState.Off, "Off"],
  [RepeatState.Track, "Track"],
  [RepeatState.All, "All"],
  [1234, "Unsupported"],
])("repeat %p", (value, output) => expect(convert.repeatStr(value)).toBe(output));

test.each([
  [ShuffleState.Off, "Off"],
  [ShuffleState.Albums, "Albums"],
  [ShuffleState.Songs, "Songs"],
  [1234, "Unsupported"],
])("shuffle %p", (value, output) => expect(convert.shuffleStr(value)).toBe(output));

test.each([
  [Protocol.MRP, "MRP"],
  [Protocol.DMAP, "DMAP"],
  [Protocol.AirPlay, "AirPlay"],
  [Protocol.Companion, "Companion"],
  [Protocol.RAOP, "RAOP"],
  [1234, "Unknown"],
])("protocol %p", (value, output) => expect(convert.protocolStr(value)).toBe(output));

test.each([
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
  [1234, "Unknown"],
])("model %p", (value, output) => expect(convert.modelStr(value)).toBe(output));
