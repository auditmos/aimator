#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// npm package name: optional @scope/, lowercase, url-safe.
const VALID_NAME = /^(?:@[a-z0-9~][a-z0-9-._~]*\/)?[a-z0-9~][a-z0-9-._~]*$/;

function read(file) {
  return readFileSync(join(ROOT, file), "utf8");
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/**
 * Literal (non-regex) replace that reports how many times it matched, so a
 * rename that silently changed nothing surfaces instead of exiting 0.
 */
function replaceIn(file, find, sub) {
  const before = read(file);
  const count = before.split(find).length - 1;

  if (count > 0) {
    writeFileSync(join(ROOT, file), before.split(find).join(sub));
  }

  return count;
}

const [, , requested] = process.argv;

if (!requested) {
  fail("usage: pnpm rename <new-package-name>");
}

if (requested.length > 214 || !VALID_NAME.test(requested)) {
  fail(
    `"${requested}" is not a valid npm package name — lowercase, no spaces, optionally @scoped.`
  );
}

const pkg = JSON.parse(read("package.json"));
const currentName = pkg.name;
const [currentBin] = Object.keys(pkg.bin ?? {});

if (currentName === requested) {
  process.stdout.write(`Already named "${requested}" — nothing to do.\n`);
  process.exit(0);
}

// A scoped package still needs a plain command name on the PATH.
const binName = requested.startsWith("@") ? requested.slice(requested.indexOf("/") + 1) : requested;

const changes = [
  ["package.json", `"name": "${currentName}"`, `"name": "${requested}"`, "name"],
  [
    "package.json",
    `"${currentBin}": "./dist/bin.js"`,
    `"${binName}": "./dist/bin.js"`,
    "bin command",
  ],
  ["src/cli.ts", `Usage: ${currentBin}`, `Usage: ${binName}`, "usage text"],
  ["README.md", `# ${currentName}\n`, `# ${requested}\n`, "title"],
];

const applied = [];
const missing = [];

for (const [file, find, sub, label] of changes) {
  const count = replaceIn(file, find, sub);
  (count > 0 ? applied : missing).push(`${file} (${label})`);
}

process.stdout.write(`Renamed ${currentName} → ${requested}\n\n`);

for (const entry of applied) {
  process.stdout.write(`  updated  ${entry}\n`);
}

for (const entry of missing) {
  process.stdout.write(`  skipped  ${entry} — already changed or not found\n`);
}

// The post-generation checklist quotes the old name deliberately, so it is left
// alone rather than rewritten into nonsense. Report it instead of guessing.
const remaining = read("README.md").split(currentName).length - 1;

if (remaining > 0) {
  process.stdout.write(
    `\nREADME.md still mentions "${currentName}" in ${remaining} place(s), mostly the\n` +
      "post-generation checklist. Rewriting the README is on that checklist.\n"
  );
}

process.stdout.write(
  "\nStill template code: src/lib/example/ and the greet command in src/cli.ts.\n"
);
