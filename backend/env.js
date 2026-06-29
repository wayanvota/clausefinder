import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function loadEnvFile(file = ".env.local") {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(file), resolve(here, "..", file), resolve(here, file)];
  const target = candidates.find((candidate) => existsSync(candidate));
  if (!target) return;
  const text = readFileSync(target, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, raw] = match;
    if (process.env[key]) continue;
    process.env[key] = raw.replace(/^["']|["']$/g, "");
  }
}
