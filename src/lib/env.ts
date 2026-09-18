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
    /**
     * One image model per track, because the two tracks are drawn side by side
     * and a single shared variable would make running both from one shell a
     * matter of editing a file between commands.
     */
    AIMATOR_IMAGE_MODEL_GPT_IMAGE: z.string().min(1).optional(),
    AIMATOR_IMAGE_MODEL_SEEDREAM: z.string().min(1).optional(),
    /**
     * The text model stage 1 sends the screenplay prompt to. Optional because
     * `--dry-run` has to work without it — and because a default here would be
     * a model choice nobody made, on a command that spends money.
     */
    AIMATOR_SCREENPLAY_MODEL: z.string().min(1).optional(),
    /**
     * The text model stage 3 sends the shot-list prompt to. Separate from the
     * screenplay's rather than shared with it: a shared variable would mean
     * that choosing a model for stage 1 quietly chose one for stage 3 too, and
     * nobody decided that. The shot list is also the longer and more mechanical
     * of the two documents, so it is a reasonable place to spend differently.
     */
    AIMATOR_SHOTLIST_MODEL: z.string().min(1).optional(),
    // Optional on purpose: a missing workspace is a recoverable, actionable
    // condition that `run()` reports as a Result. Marking it required would
    // throw here, at import time, before the CLI could explain itself.
    AIMATOR_WORKSPACE: z.string().min(1).optional(),
    /**
     * The seedream track's key. Image generation on BytePlus is a plain bearer
     * token; the AccessKey/Secret signature belongs to their asset-library API,
     * which stage 2 does not call.
     */
    BYTEPLUS_MODELARK: z.string().min(1).optional(),
    /** Read only on the paid path; `--dry-run` never asks for it. */
    OPENAI_API_KEY: z.string().min(1).optional(),
  },
});
