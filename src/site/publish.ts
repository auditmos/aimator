#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publishMedia } from "./index.js";

/**
 * A process entry, for the reason `build.ts` is one: streams and the exit code
 * stay out of `publishMedia`, which is what lets it be tested by calling a
 * function with a fake uploader instead of writing to a real bucket.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const result = await publishMedia(root);
if (result.ok) {
  for (const key of result.data) {
    process.stdout.write(`opublikowano ${key}\n`);
  }
  process.stdout.write(`Media w R2: ${result.data.length} plików.\n`);
} else {
  process.stderr.write(`Publikacja mediów nie powiodła się: ${result.error.message}\n`);
  process.exitCode = 1;
}
