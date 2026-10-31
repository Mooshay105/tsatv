/**
 * Wrapper used to force a number to be serialized as a floating point value.
 *
 * JavaScript has a single number type, so serializers (opack, plist) treat integral
 * numbers as integers. Wrap a value in Float to force it to be encoded as a real.
 */
export class Float {
  constructor(readonly value: number) {}

  valueOf(): number {
    return this.value;
  }

  toString(): string {
    return String(this.value);
  }

  toJSON(): number {
    return this.value;
  }
}

export function float(value: number): Float {
  return new Float(value);
}
