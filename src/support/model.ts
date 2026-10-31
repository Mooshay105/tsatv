/**
 * Minimal typed model (replacement for the subset of pydantic used by pyatv).
 *
 * A model class declares a static schema describing each field. Values are validated
 * when assigned via `validateField`/`update` and when constructing from plain data.
 */

export type FieldType =
  | { kind: "str"; optional?: boolean; validate?: (value: string) => string }
  | { kind: "int"; optional?: boolean }
  | { kind: "float"; optional?: boolean }
  | { kind: "bool"; optional?: boolean }
  | { kind: "enum"; name: string; values: readonly string[]; optional?: boolean }
  | { kind: "model"; factory: () => Model };

export interface FieldSpec {
  type: FieldType;
  default: () => unknown;
  /** Called on a null/undefined value before validation (like mode="before"). */
  before?: (value: unknown) => unknown;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function typeName(type: FieldType): string {
  switch (type.kind) {
    case "str":
      return type.optional ? "str, NoneType" : "str";
    case "int":
      return type.optional ? "int, NoneType" : "int";
    case "float":
      return type.optional ? "float, NoneType" : "float";
    case "bool":
      return type.optional ? "bool, NoneType" : "bool";
    case "enum":
      return type.optional ? `${type.name}, NoneType` : type.name;
    case "model":
      return "model";
  }
}

export function validateValue(name: string, type: FieldType, value: unknown): unknown {
  if (value === null || value === undefined) {
    if ("optional" in type && type.optional) return null;
    throw new ValidationError(`${name}: value is required`);
  }
  switch (type.kind) {
    case "str":
      if (typeof value !== "string") throw new ValidationError(`${name}: expected string, got ${typeof value}`);
      return type.validate ? type.validate(value) : value;
    case "int": {
      const num = typeof value === "string" && /^-?\d+$/.test(value) ? parseInt(value, 10) : value;
      if (typeof num !== "number" || !Number.isInteger(num)) {
        throw new ValidationError(`${name}: expected integer, got ${JSON.stringify(value)}`);
      }
      return num;
    }
    case "float": {
      const num = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
      if (typeof num !== "number" || Number.isNaN(num)) throw new ValidationError(`${name}: expected number`);
      return num;
    }
    case "bool":
      if (typeof value !== "boolean") throw new ValidationError(`${name}: expected boolean`);
      return value;
    case "enum":
      if (typeof value !== "string" || !type.values.includes(value)) {
        throw new ValidationError(`${name}: expected one of ${type.values.join(", ")}`);
      }
      return value;
    case "model": {
      if (value instanceof Model) return value;
      if (typeof value !== "object") throw new ValidationError(`${name}: expected object`);
      const model = type.factory();
      model.load(value as Record<string, unknown>);
      return model;
    }
  }
}

/** Base class for models. */
export abstract class Model {
  /** Return schema of this model. */
  abstract get schema(): Record<string, FieldSpec>;

  /** Initialize all fields with defaults (call from subclass constructor). */
  protected init(data?: Record<string, unknown>): void {
    for (const [name, spec] of Object.entries(this.schema)) {
      (this as any)[name] = spec.default();
    }
    if (data) this.load(data);
  }

  /** Load values from plain data (unknown fields are ignored). */
  load(data: Record<string, unknown>): this {
    for (const [name, spec] of Object.entries(this.schema)) {
      if (!(name in data)) continue;
      let value = data[name];
      if (spec.before) value = spec.before(value);
      if (spec.type.kind === "model") {
        const target = (this as any)[name] as Model;
        if (value instanceof Model) (this as any)[name] = value;
        else if (value && typeof value === "object") target.load(value as Record<string, unknown>);
        else throw new ValidationError(`${name}: expected object`);
      } else {
        (this as any)[name] = validateValue(name, spec.type, value);
      }
    }
    return this;
  }

  /** Validate a value for a field without assigning it. */
  validateField(name: string, value: unknown): unknown {
    const spec = this.schema[name];
    if (!spec) throw new ValidationError(`unknown field ${name}`);
    return validateValue(name, spec.type, spec.before ? spec.before(value) : value);
  }

  /** Return model as plain object (model_dump). */
  toDict(options: { excludeDefaults?: boolean } = {}): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [name, spec] of Object.entries(this.schema)) {
      const value = (this as any)[name];
      if (spec.type.kind === "model") {
        const sub = (value as Model).toDict(options);
        if (!options.excludeDefaults || Object.keys(sub).length > 0) out[name] = sub;
      } else if (!options.excludeDefaults || value !== spec.default()) {
        out[name] = value;
      }
    }
    return out;
  }

  /** Field names and values (dict(model) equivalent). */
  entries(): Array<[string, any]> {
    return Object.keys(this.schema).map((name) => [name, (this as any)[name]]);
  }

  /** Create a copy, updating fields with values in update (null values ignored). */
  copyWith(update: Record<string, unknown> = {}): this {
    const copy = new (this.constructor as new () => this)();
    copy.load(this.toDict());
    const filtered = Object.fromEntries(Object.entries(update).filter(([, v]) => v !== null && v !== undefined));
    copy.load(filtered);
    return copy;
  }

  equals(other: unknown): boolean {
    return other instanceof Model && JSON.stringify(this.toDict()) === JSON.stringify(other.toDict());
  }
}
