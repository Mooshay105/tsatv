/** Constants used in the public API. */

export const MAJOR_VERSION = "0";
export const MINOR_VERSION = "18";
export const PATCH_VERSION = "0";
export const SHORT_VERSION = `${MAJOR_VERSION}.${MINOR_VERSION}`;
export const VERSION = `${SHORT_VERSION}.${PATCH_VERSION}`;

/** All supported protocols. */
export enum Protocol {
  /** Protocol constant representing DMAP. */
  DMAP = 1,
  /** Protocol constant representing MRP. */
  MRP = 2,
  /** Protocol constant representing AirPlay. */
  AirPlay = 3,
  /** Protocol constant representing Companion link. */
  Companion = 4,
  /** Protocol constant representing RAOP. */
  RAOP = 5,
}

/** All supported media types. */
export enum MediaType {
  /** Media type is not known.  This can be either the case that nothing is playing or the app does not report a valid media type. */
  Unknown = 0,
  /** Media type is video. */
  Video = 1,
  /** Media type is music. */
  Music = 2,
  /** Media type is a TV show. */
  TV = 3,
}

/** All supported device states. */
export enum DeviceState {
  /** Device is idling, i.e. nothing is playing or about to play. */
  Idle = 0,
  /** Media is being loaded but not yet playing. */
  Loading = 1,
  /** Media is in paused state. */
  Paused = 2,
  /** Media is playing. */
  Playing = 3,
  /** Media is stopped. */
  Stopped = 4,
  /** Media is seeking, e.g fast forward. */
  Seeking = 5,
}

/** All supported repeat states. */
export enum RepeatState {
  /** Repeat is off. */
  Off = 0,
  /** Repeat current track or item. */
  Track = 1,
  /** Repeat all tracks or items. */
  All = 2,
}

/** All supported shuffle states. */
export enum ShuffleState {
  /** Shuffle is off. */
  Off = 0,
  /** Shuffle on album level. */
  Albums = 1,
  /** Shuffle on song level. */
  Songs = 2,
}

/** All supported power states. */
export enum PowerState {
  /** Power state is not determinable. */
  Unknown = 0,
  /** Device is turned off (standby). */
  Off = 1,
  /** Device is turned on. */
  On = 2,
}

/** All supported keyboard focus states. */
export enum KeyboardFocusState {
  /** Keyboard focus state is not determinable. */
  Unknown = 0,
  /** Keyboard is not focused. */
  Unfocused = 1,
  /** Keyboard is focused. */
  Focused = 2,
}

/** Operating system on device. */
export enum OperatingSystem {
  /** Operating system is not known. */
  Unknown = 0,
  /** Operating system  is Apple TV Software (pre-tvOS). */
  Legacy = 1,
  /** Operating system is tvOS. */
  TvOS = 2,
  /** Operating system is AirPortOS.  This OS is used by AirPort Express devices. It is not an official name but made up in pyatv as no official name has been found. */
  AirPortOS = 3,
  /** Operating system is macOS. */
  MacOS = 4,
}

/** Hardware device model.

    Gen2-Gen4K are Apple TV model names and will be renamed to AppleTVGenX in the
    future. */
export enum DeviceModel {
  /** Device model is unknown. */
  Unknown = 0,
  /** Device model is second generation Apple TV (Apple TV 2). */
  Gen2 = 1,
  /** Device model is third generation Apple TV (Apple TV 3). */
  Gen3 = 2,
  /** Device model is fourth generation Apple TV (Apple TV 4). */
  Gen4 = 3,
  /** Device model is fifth generation Apple TV (Apple TV 4K). */
  Gen4K = 4,
  /** Device model is HomePod (first generation). */
  HomePod = 5,
  /** Device model is HomePod Mini (first generation). */
  HomePodMini = 6,
  /** Device model is AirPort Express (first generation). */
  AirPortExpress = 7,
  /** Device model is AirPort Express (second generation). */
  AirPortExpressGen2 = 8,
  /** Device model is sixth generation Apple TV (Apple TV 4K gen 2). */
  AppleTV4KGen2 = 9,
  /** Music app (or iTunes) running on a desktop computer. */
  Music = 10,
  /** Device model is seventh generation Apple TV (Apple TV 4K gen 3). */
  AppleTV4KGen3 = 11,
  /** Device model is HomePod (second generation). */
  HomePodGen2 = 12,
  /** Device model is first generation Apple TV. */
  AppleTVGen1 = 13,
  /** Device model is HomePod Mini (second generation). */
  HomePodMiniGen2 = 14,
}

/** Type of input when pressing a button. */
export enum InputAction {
  /** Press and release quickly. */
  SingleTap = 0,
  /** Press and release twice quickly. */
  DoubleTap = 1,
  /** Press and hold for one second before releasing. */
  Hold = 2,
}

/** Pairing requirement for a service. */
export enum PairingRequirement {
  /** Not supported by protocol or not implemented. */
  Unsupported = 1,
  /** Pairing is disabled by protocol. */
  Disabled = 2,
  /** Pairing is not needed. */
  NotNeeded = 3,
  /** Pairing is supported but not required. */
  Optional = 4,
  /** Pairing must be performed. */
  Mandatory = 5,
}

/** State of a particular feature. */
export enum FeatureState {
  /** Feature is supported by device but it is not known if it is available or not. */
  Unknown = 0,
  /** Device does not support this feature. */
  Unsupported = 1,
  /** Feature is supported by device but not available now.  Pause is for instance unavailable if nothing is playing. */
  Unavailable = 2,
  /** Feature is supported and available. */
  Available = 3,
}

/** All supported features. */
export enum FeatureName {
  /** Up button on remote. */
  Up = 0,
  /** Down button on remote. */
  Down = 1,
  /** Left button on remote. */
  Left = 2,
  /** Right button on remote. */
  Right = 3,
  /** Start playing media. */
  Play = 4,
  /** Toggle between play/pause. */
  PlayPause = 5,
  /** Pause playing media. */
  Pause = 6,
  /** Stop playing media. */
  Stop = 7,
  /** Change to next item. */
  Next = 8,
  /** Change to previous item. */
  Previous = 9,
  /** Select current option. */
  Select = 10,
  /** Go back to previous menu. */
  Menu = 11,
  /** Increase volume. */
  VolumeUp = 12,
  /** Decrease volume. */
  VolumeDown = 13,
  /** Home/TV button. */
  Home = 14,
  /** Long-press home button (deprecated: use RemoteControl.home). */
  HomeHold = 15,
  /** Go to main menu. */
  TopMenu = 16,
  /** Suspend device (deprecated; use Power.turn_off). */
  Suspend = 17,
  /** Wake up device (deprecated; use Power.turn_on). */
  WakeUp = 18,
  /** Skip forward a time interval. */
  SkipForward = 36,
  /** Skip backwards a time interval. */
  SkipBackward = 37,
  /** Seek to position. */
  SetPosition = 19,
  /** Change shuffle state. */
  SetShuffle = 20,
  /** Change repeat state. */
  SetRepeat = 21,
  /** Select next channel. */
  ChannelUp = 48,
  /** Select previous channel. */
  ChannelDown = 49,
  /** Title of playing media. */
  Title = 22,
  /** Artist of playing song. */
  Artist = 23,
  /** Album from playing artist. */
  Album = 24,
  /** Genre of playing song. */
  Genre = 25,
  /** Total length of playing media (seconds). */
  TotalTime = 26,
  /** Current play time position. */
  Position = 27,
  /** Shuffle state. */
  Shuffle = 28,
  /** Repeat state. */
  Repeat = 29,
  /** Title of TV series. */
  SeriesName = 40,
  /** Season number of TV series. */
  SeasonNumber = 41,
  /** Episode number of TV series. */
  EpisodeNumber = 42,
  /** Identifier for Content */
  ContentIdentifier = 47,
  /** iTunes Store Identifier for Content */
  iTunesStoreIdentifier = 50,
  /** List of launchable apps. */
  AppList = 38,
  /** Launch an app. */
  LaunchApp = 39,
  /** List of user accounts. */
  AccountList = 55,
  /** Switch user account. */
  SwitchAccount = 56,
  /** Playing media artwork. */
  Artwork = 30,
  /** App playing media. */
  App = 35,
  /** Push updates are supported. */
  PushUpdates = 43,
  /** Stream a URL on device. */
  PlayUrl = 31,
  /** Stream local file to device. */
  StreamFile = 44,
  /** Current device power state. */
  PowerState = 32,
  /** Activate screen saver. */
  Screensaver = 58,
  /** Turn device on. */
  TurnOn = 33,
  /** Turn off device. */
  TurnOff = 34,
  /** Current volume level. */
  Volume = 45,
  /** Set volume level. */
  SetVolume = 46,
  /** Current output devices. */
  OutputDevices = 59,
  /** Add output devices. */
  AddOutputDevices = 60,
  /** Remove output devices. */
  RemoveOutputDevices = 61,
  /** Set output devices. */
  SetOutputDevices = 62,
  /** Current virtual keyboard focus state. */
  TextFocusState = 57,
  /** Get current virtual keyboard text. */
  TextGet = 51,
  /** Clear virtual keyboard text. */
  TextClear = 52,
  /** Input text into virtual keyboard. */
  TextAppend = 53,
  /** Replace text in virtual keyboard. */
  TextSet = 54,
  /** Touch swipe from given coordinates and duration. */
  Swipe = 63,
  /** Touch event to given coordinates. */
  Action = 64,
  /** Touch click command. */
  Click = 65,
  /** Show EPG. */
  Guide = 66,
  /** Open the Control Center. */
  ControlCenter = 68,
}

/** Touch action constants. */
export enum TouchAction {
  Press = 1,
  Hold = 3,
  Release = 4,
  Click = 5,
}

