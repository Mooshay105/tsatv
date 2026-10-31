/** Access to environment variables (patchable in tests). */

export function getEnv(name: string): string | undefined {
  return process.env[name];
}
