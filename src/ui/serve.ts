import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getRequestListener } from "@hono/node-server";
import react from "@vitejs/plugin-react";
import { createServer as createViteServer } from "vite";
import { env } from "../lib/env.js";
import { resolveWorkspace } from "../lib/workspace.js";
import { createUi } from "./index.js";

/**
 * The process entry: one port, one address, and nothing published.
 *
 * `bin.ts` is the shape this follows. Everything about the process lives here,
 * which is what leaves `createUi` a function a test can call, and it is why
 * the workspace is resolved in this file rather than inside the app: the
 * environment is a fact about the machine, not about the server.
 *
 * One process serves both halves, and the split inside it is the same one the
 * whole project rests on. Vite owns the browser side: the client's files, its
 * reloads, its assets. Hono owns `/api`, which is the CLI and nothing else.
 * Two processes would have bought a proxy, a second log and a second thing to
 * kill, for one address that already exists here.
 *
 * It listens on the loopback address only. This is a tool for one person on
 * one machine, with no authentication of any kind, so the binding is the
 * security model rather than a default that could be widened later.
 */

const HOST = "127.0.0.1";
const PORT = 4317;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const workspace = resolveWorkspace(env.AIMATOR_WORKSPACE);

if (workspace.ok) {
  const vite = await createViteServer({
    configFile: false,
    plugins: [react()],
    // The wordmark and the webfonts are the branding repository's copies under
    // `site/assets`, served from where they already are rather than duplicated
    // into a second directory that would then be a second thing to update.
    publicDir: join(repoRoot, "site/assets"),
    root: join(repoRoot, "ui"),
    server: { host: HOST, middlewareMode: true },
  });
  const api = getRequestListener(createUi({ workspace: workspace.data }).fetch);

  createServer((request, response) => {
    if (request.url?.startsWith("/api/") === true) {
      api(request, response);

      return;
    }

    vite.middlewares(request, response);
  }).listen(PORT, HOST, () => {
    process.stdout.write(
      `aimator UI: http://${HOST}:${PORT}\nKatalog roboczy: ${workspace.data.root}\n`
    );
  });
} else {
  process.stderr.write(`${workspace.error.message}\n`);
  process.exitCode = 1;
}
