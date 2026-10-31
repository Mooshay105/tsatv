/**
 * Generate TypeScript protobuf classes from the MRP .proto files.
 *
 * Usage: bun scripts/gen_protobuf.ts
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const PROTO_DIR = path.join(import.meta.dir, "..", "protos", "mrp");
const OUTPUT = path.join(import.meta.dir, "..", "src", "protocols", "mrp", "protobuf", "index.ts");

interface EnumDef {
  name: string; // Full name, e.g. "ProtocolMessage.Type" or "Command"
  values: Array<[string, number]>;
}

interface FieldDef {
  label: string;
  type: string;
  name: string;
  number: number;
  extension: boolean;
}

interface MessageDef {
  name: string;
  fields: FieldDef[];
  enums: EnumDef[];
  file: string;
}

const messages = new Map<string, MessageDef>();
const topEnums = new Map<string, EnumDef>();
const extensions: Array<{ target: string; field: FieldDef }> = [];

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function tokenize(text: string): string[] {
  return text.match(/"[^"]*"|[A-Za-z_][A-Za-z0-9_.]*|-?\d+|[{}=;\[\],<>()]/g) ?? [];
}

class Parser {
  pos = 0;
  constructor(
    readonly tokens: string[],
    readonly file: string,
  ) {}

  peek(): string | undefined {
    return this.tokens[this.pos];
  }

  next(): string {
    const token = this.tokens[this.pos++];
    if (token === undefined) throw new Error(`unexpected end of ${this.file}`);
    return token;
  }

  expect(value: string): void {
    const token = this.next();
    if (token !== value) throw new Error(`${this.file}: expected ${value} but got ${token}`);
  }

  skipStatement(): void {
    while (this.next() !== ";");
  }

  parseFile(): void {
    while (this.peek() !== undefined) {
      const token = this.next();
      if (token === "syntax" || token === "import" || token === "package" || token === "option") {
        this.skipStatement();
      } else if (token === "message") {
        this.parseMessage();
      } else if (token === "enum") {
        const def = this.parseEnum("");
        topEnums.set(def.name, def);
      } else if (token === "extend") {
        this.parseExtend();
      } else {
        throw new Error(`${this.file}: unexpected token ${token}`);
      }
    }
  }

  parseEnum(prefix: string): EnumDef {
    const name = this.next();
    this.expect("{");
    const values: Array<[string, number]> = [];
    while (this.peek() !== "}") {
      const valueName = this.next();
      if (valueName === "option" || valueName === "reserved") {
        this.skipStatement();
        continue;
      }
      this.expect("=");
      const value = parseInt(this.next(), 10);
      if (this.peek() === "[") while (this.next() !== "]");
      this.expect(";");
      values.push([valueName, value]);
    }
    this.expect("}");
    if (this.peek() === ";") this.next();
    return { name: prefix ? `${prefix}.${name}` : name, values };
  }

  parseField(): FieldDef {
    let label = this.next();
    let type: string;
    if (label === "optional" || label === "required" || label === "repeated") {
      type = this.next();
    } else {
      type = label;
      label = "optional";
    }
    const name = this.next();
    this.expect("=");
    const number = parseInt(this.next(), 10);
    if (this.peek() === "[") {
      while (this.next() !== "]");
    }
    this.expect(";");
    return { label, type, name, number, extension: false };
  }

  parseMessage(): void {
    const name = this.next();
    this.expect("{");
    const def: MessageDef = { name, fields: [], enums: [], file: this.file };
    while (this.peek() !== "}") {
      const token = this.peek();
      if (token === "enum") {
        this.next();
        def.enums.push(this.parseEnum(name));
      } else if (token === "extensions" || token === "reserved" || token === "option") {
        this.skipStatement();
      } else if (token === "message") {
        throw new Error(`${this.file}: nested messages are not supported`);
      } else {
        def.fields.push(this.parseField());
      }
    }
    this.expect("}");
    messages.set(name, def);
  }

  parseExtend(): void {
    const target = this.next();
    this.expect("{");
    while (this.peek() !== "}") {
      const fieldDef = this.parseField();
      fieldDef.extension = true;
      extensions.push({ target, field: fieldDef });
    }
    this.expect("}");
  }
}

for (const file of readdirSync(PROTO_DIR).filter((f) => f.endsWith(".proto")).sort()) {
  const text = stripComments(readFileSync(path.join(PROTO_DIR, file), "utf-8"));
  new Parser(tokenize(text), file).parseFile();
}

for (const { target, field } of extensions) {
  const msg = messages.get(target);
  if (!msg) throw new Error(`extension target ${target} not found`);
  msg.fields.push(field);
}

const SCALARS: Record<string, string> = {
  double: "number",
  float: "number",
  int32: "number",
  int64: "number",
  uint32: "number",
  uint64: "number",
  sint32: "number",
  sint64: "number",
  fixed32: "number",
  fixed64: "number",
  sfixed32: "number",
  sfixed64: "number",
  bool: "boolean",
  string: "string",
  bytes: "Buffer",
};

const allEnums = new Map<string, EnumDef>(topEnums);
for (const msg of messages.values()) for (const e of msg.enums) allEnums.set(e.name, e);

function enumVar(fullName: string): string {
  return fullName.replace(/\./g, "_") + "$enum";
}

function resolveType(type: string, scope: string): { kind: "scalar" | "enum" | "message"; name: string } {
  if (type in SCALARS) return { kind: "scalar", name: type };
  if (allEnums.has(`${scope}.${type}`)) return { kind: "enum", name: `${scope}.${type}` };
  if (allEnums.has(type)) return { kind: "enum", name: type };
  if (messages.has(type)) return { kind: "message", name: type };
  throw new Error(`unknown type ${type} in ${scope}`);
}

const RESERVED_STATICS = new Set(["name", "length", "prototype", "caller", "arguments", "info", "decode"]);

const out: string[] = [];
out.push("/**");
out.push(" * Protobuf messages used by MRP.");
out.push(" *");
out.push(" * THIS CODE IS AUTO-GENERATED BY scripts/gen_protobuf.ts - DO NOT EDIT!!!");
out.push(" */");
out.push("");
out.push("/* eslint-disable */");
out.push('import { defineEnum, defineMessage, field, Message, type MessageInfo, RepeatedField } from "./runtime.ts";');
out.push("");
out.push('export { Message, RepeatedField, messageToString, DecodeError, enumName } from "./runtime.ts";');
out.push("");

// Enums
for (const def of [...allEnums.values()]) {
  const body = def.values.map(([k, v]) => `${k}: ${v}`).join(", ");
  out.push(`const ${enumVar(def.name)} = defineEnum("${def.name}", { ${body} });`);
}
out.push("");

for (const def of topEnums.values()) {
  out.push(`export const ${def.name} = {`);
  for (const [k, v] of def.values) out.push(`  ${k}: ${v},`);
  out.push("} as const;");
  out.push(`export type ${def.name} = number;`);
  out.push("");
}

for (const msg of messages.values()) {
  const fieldLines: string[] = [];
  const accessors: string[] = [];
  const initLines: string[] = [];
  for (const f of msg.fields) {
    const resolved = resolveType(f.type, msg.name);
    const repeated = f.label === "repeated";
    const opts: string[] = [];
    if (repeated) opts.push("repeated: true");
    if (f.extension) opts.push("extension: true");
    let tsType: string;
    let initType: string;
    let typeName: string;
    if (resolved.kind === "scalar") {
      tsType = SCALARS[resolved.name]!;
      initType = resolved.name === "bytes" ? "Uint8Array" : tsType;
      typeName = resolved.name;
    } else if (resolved.kind === "enum") {
      tsType = "number";
      initType = "number";
      typeName = "enum";
      opts.push(`enum: ${enumVar(resolved.name)}`);
    } else {
      tsType = resolved.name;
      initType = `${resolved.name} | ${resolved.name}Init`;
      typeName = "message";
      opts.push(`message: () => ${resolved.name}`);
    }
    const optStr = opts.length ? `, { ${opts.join(", ")} }` : "";
    fieldLines.push(`    field("${f.name}", ${f.number}, "${typeName}"${optStr}),`);
    if (repeated) {
      accessors.push(`  get ${f.name}(): RepeatedField<${tsType}> {`);
      accessors.push(`    return this._get("${f.name}");`);
      accessors.push("  }");
      accessors.push(`  set ${f.name}(value: Iterable<${tsType}>) {`);
      accessors.push(`    this._set("${f.name}", value);`);
      accessors.push("  }");
      initLines.push(`  ${f.name}?: Iterable<${tsType}>;`);
    } else {
      accessors.push(`  get ${f.name}(): ${tsType} {`);
      accessors.push(`    return this._get("${f.name}");`);
      accessors.push("  }");
      accessors.push(`  set ${f.name}(value: ${initType}) {`);
      accessors.push(`    this._set("${f.name}", value);`);
      accessors.push("  }");
      initLines.push(`  ${f.name}?: ${initType};`);
    }
  }

  out.push(`export interface ${msg.name}Init {`);
  out.push(...initLines);
  out.push("}");
  out.push("");
  out.push(`export class ${msg.name} extends Message {`);
  out.push(`  static readonly info: MessageInfo = defineMessage("${msg.name}", () => [`);
  out.push(...fieldLines);
  out.push("  ]);");
  for (const e of msg.enums) {
    const shortName = e.name.split(".").pop()!;
    out.push("");
    out.push(`  static readonly ${shortName} = {`);
    for (const [k, v] of e.values) out.push(`    ${k}: ${v},`);
    out.push("  } as const;");
    for (const [k, v] of e.values) {
      if (RESERVED_STATICS.has(k)) continue;
      out.push(`  static readonly ${k} = ${v};`);
    }
  }
  out.push("");
  out.push(`  constructor(init?: ${msg.name}Init) {`);
  out.push("    super(init as Record<string, unknown>);");
  out.push("  }");
  out.push("");
  out.push(...accessors);
  out.push("}");
  out.push("");
}

// Message type constants and extension lookup
const lookup: Record<string, string> = JSON.parse(readFileSync(path.join(PROTO_DIR, "extension_lookup.json"), "utf-8"));
const typeEnum = messages.get("ProtocolMessage")!.enums.find((e) => e.name === "ProtocolMessage.Type")!;
const typeValues = new Map(typeEnum.values);
out.push("/** Mapping from message type to extension field name in ProtocolMessage. */");
out.push("export const EXTENSION_LOOKUP: ReadonlyMap<number, string> = new Map([");
for (const [typeName, extName] of Object.entries(lookup)) {
  out.push(`  [${typeValues.get(typeName)}, "${extName}"], // ${typeName}`);
}
out.push("]);");
out.push("");
for (const typeName of Object.keys(lookup)) {
  out.push(`export const ${typeName} = ${typeValues.get(typeName)};`);
}
out.push("");
out.push("/** Extract inner message based on type. */");
out.push("export function extractInner(message: ProtocolMessage): any {");
out.push("  const extension = EXTENSION_LOOKUP.get(message.type);");
out.push("  if (extension) return (message as any)[extension];");
out.push('  throw new Error("unknown type: " + String(message.type));');
out.push("}");
out.push("");

writeFileSync(OUTPUT, out.join("\n"));
console.log(`Generated ${messages.size} messages and ${allEnums.size} enums -> ${OUTPUT}`);
