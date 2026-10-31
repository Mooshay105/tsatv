/**
 * Methods for working with time and synchronization in RAOP.
 *
 * The timing routines in this module is based on the excellent work of RAOP-Player:
 * https://github.com/philippe44/RAOP-Player
 */

/** Hooks replaceable in tests. */
export const timingHooks = {
  /** Current time in nanoseconds. */
  timeNs: (): bigint => BigInt(Math.floor((performance.timeOrigin + performance.now()) * 1e6)),
};

/** Return current time in NTP format. */
export function ntpNow(): bigint {
  const nowUs = timingHooks.timeNs() / 1000n;
  const seconds = nowUs / 1000000n;
  const frac = nowUs - seconds * 1000000n;
  return ((seconds + 0x83aa7e80n) << 32n) | ((frac << 32n) / 1000000n);
}

/** Split NTP time into seconds and fraction. */
export function ntp2parts(ntp: bigint): [number, number] {
  return [Number(ntp >> 32n), Number(ntp & 0xffffffffn)];
}

/** Convert NTP time into timestamp. */
export function ntp2ts(ntp: bigint, rate: number): number {
  return Number(((ntp >> 16n) * BigInt(rate)) >> 16n);
}

/** Convert timestamp into NTP time. */
export function ts2ntp(timestamp: number, rate: number): bigint {
  return ((BigInt(Math.trunc(timestamp)) << 16n) / BigInt(rate)) << 16n;
}

/** Convert NTP time to milliseconds. */
export function ntp2ms(ntp: bigint): number {
  return Number(((ntp >> 10n) * 1000n) >> 22n);
}

/** Convert timestamp to milliseconds. */
export function ts2ms(timestamp: number, rate: number): number {
  return ntp2ms(ts2ntp(timestamp, rate));
}
