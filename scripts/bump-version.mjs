#!/usr/bin/env node
/**
 * Régénère `public/version.json` et `src/lib/build-version.ts` avec un
 * timestamp unique. Lancé en prebuild → chaque déploiement a sa propre
 * version, et le polling côté client (VersionChecker) déclenche un reload.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const version = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const builtAt = new Date().toISOString();

const publicPath = join(root, "public", "version.json");
mkdirSync(dirname(publicPath), { recursive: true });
writeFileSync(
  publicPath,
  JSON.stringify({ version, builtAt }, null, 2) + "\n",
);

const tsPath = join(root, "src", "lib", "build-version.ts");
writeFileSync(
  tsPath,
  `// Généré par scripts/bump-version.mjs — ne pas éditer à la main.\nexport const BUILD_VERSION = ${JSON.stringify(version)};\nexport const BUILT_AT = ${JSON.stringify(builtAt)};\n`,
);

console.log(`[bump-version] ${version} (${builtAt})`);
