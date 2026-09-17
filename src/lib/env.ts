import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

// `process.loadEnvFile` never overwrites a key that is already set, so the
// file loaded FIRST wins. `.env.local` therefore has to come before `.env`
// for the documented precedence (shell > .env.local > .env) to hold.
for (const file of [".env.local", ".env"]) {
  const path = resolve(process.cwd(), file);

  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
}

export const env = createEnv({
  emptyStringAsUndefined: true,
  runtimeEnv: process.env,
  server: {
    // Optional on purpose: a missing workspace is a recoverable, actionable
    // condition that `run()` reports as a Result. Marking it required would
    // throw here, at import time, before the CLI could explain itself.
    AIMATOR_WORKSPACE: z.string().min(1).optional(),
  },
});
