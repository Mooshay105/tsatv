# tsatv

A TypeScript port of [pyatv](https://pyatv.dev) (version 0.18.0) for [Bun](https://bun.com):
a client library for Apple TV and AirPlay devices.

It supports scanning, pairing and connecting to devices over all protocols supported by
pyatv: **AirPlay** (v1 and v2, including the MRP tunnel), **Companion**, **DMAP**, **MRP**
and **RAOP** (audio streaming). The bundled scripts `atvremote`, `atvscript`, `atvlog`
and `atvproxy` are included too.

There are no runtime dependencies. Everything (protobuf, OPACK, binary plist, SRP,
ChaCha20-Poly1305, mDNS, RTSP, ...) is implemented using Bun/Node built-ins.

## Installation

```bash
bun add tsatv
```

tsatv requires [Bun](https://bun.com) (>= 1.2) at runtime; it uses Bun APIs such as
`Bun.serve`, `Bun.listen` and `Bun.file` and does not run on Node.js.

## Getting started

```ts
import { connect, scan } from "tsatv";

const atvs = await scan({ timeout: 5 });
console.log(atvs.map(String).join("\n"));

const atv = await connect(atvs[0]!);
try {
	console.log(String(await atv.metadata.playing()));
	await atv.remoteControl.playPause();
} finally {
	await Promise.allSettled(atv.close());
}
```

Pairing works the same way as in pyatv:

```ts
import { pair } from "tsatv";
import { Protocol } from "tsatv";

const pairing = await pair(config, Protocol.Companion);
await pairing.begin();
pairing.pin(1234); // PIN shown on screen
await pairing.finish();
console.log(pairing.service.credentials);
await pairing.close();
```

## Building on tsatv: `tsatv/airplay`

`tsatv/airplay` exposes the lower-level AirPlay building blocks that tsatv itself is
built from, for packages that implement more of AirPlay on top of it (for example a
screen mirroring sender). It is a supported entry point. Deep imports such as
`tsatv/support/rtsp` are not: their layout may change.

```ts
import { extractCredentials, httpConnect, Protocol, RtspSession, verifyConnection } from "tsatv/airplay";

const service = config.getService(Protocol.AirPlay)!; // config from scan(), credentials applied
const connection = await httpConnect(String(config.address), service.port);
const verifier = await verifyConnection(extractCredentials(service), connection);
const rtsp = new RtspSession(connection); // requests are now HAP encrypted
const secret = verifier.sharedSecret?.(); // pair-verify secret, for deriving more keys
```

It contains:

- **Credentials and pairing:** `HapCredentials`, `parseCredentials`, `extractCredentials`,
  `pairSetup`, `pairVerify`, `verifyConnection` and the HAP / transient procedures.
  Their pairing headers can be changed (`{ headers: { "X-Apple-HKP": 5 } }`), pair-setup
  can add TLV items to M5 (`additionalData`), and `sharedSecret()` returns the secret
  that all session keys are derived from (X25519 for HAP, the SRP key for transient).
- **Connections and channels:** `HttpConnection`/`httpConnect`, `RtspSession` (with
  configurable `userAgent` and a per-request `timeout`), `HAPSession`,
  `AbstractHAPChannel`/`setupChannel` for HAP-framed side channels, TCP/UDP transports
  and the `Events-*`/`DataStream-*` key derivation labels.
- **Crypto:** ChaCha20-Poly1305, HKDF, X25519 and Ed25519.
- **Encodings:** `plistlib` (binary plist), `tlv8` and `opack`.
- **Timing:** `TimingServer` (NTP style) and the NTP helpers in `timing`.
- **Feature flags:** `AirPlayFlags`, `parseFeatures`, `hasFlag` (for example
  `AirPlayFlags.SupportsAirPlayScreen` is bit 7).
- **Configuration and storage:** `FileStorage`, `MemoryStorage`, `Protocol`.

## Scripts

The scripts are installed as executables (`bunx atvremote ...`, or globally with
`bun add -g tsatv`):

```bash
atvremote scan
atvremote --id <identifier> playing
atvremote --id <identifier> --protocol companion pair
atvscript --id <identifier> push_updates
atvlog -o log.html pyatv.log
atvproxy mrp <credentials> <ip>
```

From a checkout of this repository, run them with `bun run`:

```bash
bun run atvremote scan
bun run atvremote --id <identifier> playing
bun run atvremote --id <identifier> --protocol companion pair
bun run atvscript --id <identifier> push_updates
bun run atvlog -o log.html pyatv.log
bun run atvproxy mrp <credentials> <ip>
```

Commands and arguments are the same as in pyatv (snake_case, e.g. `play_pause`,
`set_volume=50`, `print_settings`). Run `atvremote commands` for a full list.

## Differences from pyatv

The API follows pyatv closely but is adapted to TypeScript conventions:

- **Naming:** methods and properties use camelCase (`playPause()`, `deviceState`,
  `remoteControl`). Listener methods do too (`playstatusUpdate`, `connectionLost`,
  `powerstateUpdate`, ...). **Settings** keep their snake_case field names
  (`settings.protocols.airplay.credentials`) so the storage file format is compatible
  with pyatv.
- **No event loop argument:** functions like `scan`, `connect` and `pair` take an
  options object instead of `loop` + keyword arguments, e.g.
  `connect(config, { protocol, storage })`.
- **Types:** enums are numeric TypeScript enums, addresses are strings, binary data is
  `Buffer`, 64-bit values that don't fit a JavaScript number are `bigint`.
- **`close()`** returns a `Set<Promise>` (instead of a set of tasks), so use
  `await Promise.allSettled(atv.close())`.
- **Streaming (`streamFile`)** accepts a file name, an HTTP(S) URL, a `Uint8Array`, a web
  `ReadableStream`, an async iterable of bytes or anything with an async `read()` method.
- **Audio decoding:** pyatv uses miniaudio. Here WAV files are decoded natively; other
  formats (MP3, FLAC, Ogg Vorbis, ...) are decoded with `ffmpeg`/`ffprobe`, which must be
  installed on the system for those formats. Metadata is read natively from WAV (RIFF
  INFO and ID3) and ID3v2 tags; other formats use `ffprobe`.
- **Zeroconf:** pyatv can scan using python-zeroconf. This port always uses its own mDNS
  implementation (the same as pyatv's default scanner), and includes a minimal mDNS
  responder for publishing services (used by DMAP pairing and `atvproxy`).

## Project layout

- `src/` – the library (same module structure as `pyatv/`), scripts in `src/scripts/`
- `tests/` – the pyatv test suite ported to `bun test`, including fake devices for all
  protocols in `tests/fake_device/`
- `protos/` and `scripts/gen_protobuf.ts` – MRP protobuf definitions and the code
  generator producing `src/protocols/mrp/protobuf/index.ts` (`bun run gen-protobuf`)

## Development

```bash
bun install
bun test          # run test suite
bun run typecheck # type check with tsc
bun run build     # compile to dist/ (JS + type declarations)
```

`npm publish` (or `bun publish`) runs type checking, the test suite and the build
automatically via `prepublishOnly`.

## Testing

All of pyatv's tests are ported (1250+ tests) and run in a few seconds. The three tests
skipped in pyatv are also skipped here. `atvproxy`, which has no tests in pyatv, has
end-to-end tests for its MRP and Companion proxies. Its AirPlay proxy is untested, since
the fake AirPlay device only supports legacy (AirPlay 1) authentication.

Set `PYATV_TEST_LOG=1` to print debug logs when running tests.

## License

MIT. tsatv is a port of [pyatv](https://github.com/postlund/pyatv) by Pierre Ståhl,
also MIT licensed. See [LICENSE.md](LICENSE.md).
