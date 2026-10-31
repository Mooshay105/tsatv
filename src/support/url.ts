/** Helpers for working with URLs. */

const URL_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):(?:\/\/([^/?#]*))?/;

function parse(url: string): { scheme: string; netloc: string } {
  const match = URL_RE.exec(url);
  if (!match) return { scheme: "", netloc: "" };
  return { scheme: match[1] ?? "", netloc: match[2] ?? "" };
}

/** Check if something is a URL. */
export function isUrl(url: string): boolean {
  const parts = parse(url);
  return Boolean(parts.scheme && parts.netloc);
}

/** Check if something is a URL or a URL scheme. */
export function isUrlOrScheme(url: string): boolean {
  return Boolean(parse(url).scheme);
}
