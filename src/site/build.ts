#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSite } from "./index.js";

/**
 * A process entry, for the reason `bin.ts` is one: streams and exit codes stay
 * out of `buildSite`, which is what lets the build be tested by calling a
 * function instead of spawning a process.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const result = await buildSite(root);
if (result.ok) {
  process.stdout.write(`Strona gotowa: ${result.data}\n`);
} else {
  process.stderr.write(`Budowanie strony nie powiodło się: ${result.error.message}\n`);
  process.exitCode = 1;
}
