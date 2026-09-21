#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config/index.js";
import { resolveWorkspace } from "../lib/workspace.js";
import { freezeRelease } from "./index.js";

/**
 * A process entry, for the reason `build.ts` and `publish.ts` are: streams,
 * arguments and the exit code stay out of `freezeRelease`, which is what lets
 * it be tested by calling a function.
 */

const [projectId, episodeId, version] = process.argv.slice(2);
const workspace = resolveWorkspace(config.env.AIMATOR_WORKSPACE);
if (!(projectId && episodeId && version)) {
  process.stderr.write("Użycie: pnpm site:freeze <projekt> <odcinek> <wersja>\n");
  process.stderr.write("Przykład: pnpm site:freeze dzielna-ewa 01-burza 0.2.0\n");
  process.exitCode = 1;
} else if (workspace.ok) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const result = await freezeRelease({
    episodeId,
    projectId,
    root,
    version,
    workspace: workspace.data,
  });
  if (result.ok) {
    for (const file of result.data.files) {
      process.stdout.write(`zapisano ${file}\n`);
    }
    process.stdout.write(`\nZamrożono ${result.data.files.length} plików.\n`);
    process.stdout.write(
      `Do napisania w site/releases/${version}.json (${result.data.unwritten.length} pól):\n`
    );
    for (const field of result.data.unwritten) {
      process.stdout.write(`  ${field}\n`);
    }
    process.stdout.write("\nDopóki zostaje tam TODO, pnpm site:build odmówi.\n");
  } else {
    process.stderr.write(`Zamrożenie nie powiodło się: ${result.error.message}\n`);
    process.exitCode = 1;
  }
} else {
  process.stderr.write(`${workspace.error.message}\n`);
  process.exitCode = 1;
}
