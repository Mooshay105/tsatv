/**
 * Build the npm package into dist/.
 *
 * Compiles src/ with tsc (JS + declarations), then rewrites relative ".ts" import
 * specifiers left in the emitted .d.ts files to ".js" so consumers resolve them under
 * any moduleResolution mode, and marks the CLI entry points as executable.
 *
 * Usage: bun scripts/build.ts
 */

import { chmod, rm } from "node:fs/promises";
import path from "node:path";
import pkg from "../package.json";

const ROOT = path.join(import.meta.dir, "..");
const DIST = path.join(ROOT, "dist");

await rm(DIST, { recursive: true, force: true });

const tsc = Bun.spawnSync(["bun", "x", "tsc", "-p", "tsconfig.build.json"], {
  cwd: ROOT,
  stdout: "inherit",
  stderr: "inherit",
});
if (tsc.exitCode !== 0) {
  console.error("tsc failed");
  process.exit(tsc.exitCode ?? 1);
}

// Rewrite `"./foo.ts"` / `'../bar.ts'` (relative only) to `.js` in declaration files.
const SPECIFIER = /(["'])(\.{1,2}\/[^"']*?)\.ts\1/g;
let rewritten = 0;
for await (const rel of new Bun.Glob("**/*.d.ts").scan(DIST)) {
  const file = path.join(DIST, rel);
  const text = await Bun.file(file).text();
  const updated = text.replace(SPECIFIER, (_, q: string, spec: string) => `${q}${spec}.js${q}`);
  if (updated !== text) {
    await Bun.write(file, updated);
    rewritten++;
  }
}

for (const bin of Object.values(pkg.bin)) {
  await chmod(path.join(ROOT, bin), 0o755);
}

console.log(`Built dist/ (${rewritten} declaration files rewritten)`);
