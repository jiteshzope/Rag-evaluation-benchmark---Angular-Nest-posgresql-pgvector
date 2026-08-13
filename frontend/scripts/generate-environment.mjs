/**
 * Writes src/environments/environment.ts from the environment.
 *
 * Angular's builder has no `.env` support of its own — only `define`, which
 * takes literal values in angular.json and so cannot read a variable. This runs
 * ahead of `ng build` and `ng serve` (see the npm pre* hooks) and turns whatever
 * the environment holds into the constant the app imports.
 *
 * Precedence is dotenv's: a variable already set in the real environment wins
 * over the `.env` file. That is what makes the same code work locally, where the
 * value comes from `.env`, and on Vercel, where it comes from the project's
 * environment variables and no `.env` file exists.
 *
 * The output is generated, not source: it is gitignored, and editing it by hand
 * is pointless because the next build overwrites it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(ROOT, 'src', 'environments', 'environment.ts');

/** Minimal .env reader — enough for this file, and no dependency to install. */
function readEnvFile(path) {
  if (!existsSync(path)) return {};

  const values = {};
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

const fileEnv = { ...readEnvFile(join(ROOT, '.env')), ...readEnvFile(join(ROOT, '.env.local')) };

/** Real environment first, then .env — the same order dotenv and Vite use. */
function read(name) {
  return process.env[name] !== undefined ? process.env[name] : fileEnv[name];
}

const production =
  process.env['NODE_ENV'] === 'production' || process.argv.includes('--production');
const apiBaseUrl = read('NG_APP_API_BASE_URL');

if (apiBaseUrl === undefined) {
  console.warn(
    '\x1b[33m[env] NG_APP_API_BASE_URL is not set — API requests will be relative to the site itself.\x1b[0m\n' +
      '      Copy .env.example to .env locally, or add the variable in Vercel → Settings → Environment Variables.\n' +
      '      Set it to an empty value on purpose if the UI and the API really are served from one origin.',
  );
} else if (apiBaseUrl === '') {
  console.log(
    '[env] NG_APP_API_BASE_URL is empty — API requests will be relative to the site itself.',
  );
} else {
  console.log(`[env] API base URL: ${apiBaseUrl}`);
}

const contents = `// GENERATED FILE — do not edit, and do not commit.
//
// Written by scripts/generate-environment.mjs from NG_APP_API_BASE_URL, which
// comes from .env locally and from the project's environment variables in CI.
// See .env.example.

export const environment = {
  production: ${production},
  apiBaseUrl: ${JSON.stringify(apiBaseUrl ?? '')},
};
`;

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, contents, 'utf8');
