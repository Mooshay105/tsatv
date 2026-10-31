/** Module to read and write Google protobuf variants. */

/** Read and parse a binary protobuf variant value. */
export function readVariant(variant: Uint8Array): [number, Buffer] {
  let result = 0;
  let cnt = 0;
  for (const data of variant) {
    result += (data & 0x7f) * 2 ** (7 * cnt);
    cnt += 1;
    if (!(data & 0x80)) {
      return [result, Buffer.from(variant.subarray(cnt))];
    }
  }
  throw new RangeError("invalid variant");
}

/** Convert an integer to a protobuf variant binary buffer. */
export function writeVariant(number: number): Buffer {
  const out: number[] = [];
  let n = number;
  while (n >= 128) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
}
