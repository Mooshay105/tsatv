/** JSON serialization using Python's json.dumps formatting (", " and ": "). */

export function pyJsonDumps(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    // Python escapes all non-ASCII characters by default
    return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  }
  if (Array.isArray(value)) return "[" + value.map(pyJsonDumps).join(", ") + "]";
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    return "{" + entries.map(([k, v]) => `${pyJsonDumps(k)}: ${pyJsonDumps(v)}`).join(", ") + "}";
  }
  return JSON.stringify(value);
}
