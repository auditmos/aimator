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
     * Stage 10's two audio call sites: `AIMATOR_MUSIC_MODEL` composes a bed and
     * this one renders a sound effect. **One variable each for both tracks**,
     * like the video model and the voice model and for the same reason,
     * neither is *drawn*, so neither has any idea which of the two films it
     * will end up under.
     *
     * Two variables rather than one, because they are two endpoints with two
     * models behind them: a shared one would mean that choosing how the score
     * sounds quietly chose how a thunderclap does, which nobody decided. The
     * key for both is `ELEVENLABS_API_KEY`, shared with stage 9, the key
     * follows the provider, the variable follows the call site.
     */
    AIMATOR_EFFECTS_MODEL: z.string().min(1).optional(),
    /**
     * Where stage 8's muxer lives, when it is not simply `ffmpeg` on PATH.
     *
     * The only variable here that names a program rather than a model or a
     * key, and the only one whose absence has a sensible answer: every other
     * one refuses a default because a model nobody chose is not a decision,
     * while "the ffmpeg on PATH" is not a choice between engines; it is the
     * engine, wherever this machine keeps it. The escape hatch exists for a
     * build that is not on PATH, not for picking a different tool.
     */
    AIMATOR_FFMPEG: z.string().min(1).optional(),
    /**
     * One image model per track, because the two tracks are drawn side by side
     * and a single shared variable would make running both from one shell a
     * matter of editing a file between commands.
     */
    AIMATOR_IMAGE_MODEL_GPT_IMAGE: z.string().min(1).optional(),
    AIMATOR_IMAGE_MODEL_SEEDREAM: z.string().min(1).optional(),
    /** Stage 10's other audio call site; see `AIMATOR_EFFECTS_MODEL` above. */
    AIMATOR_MUSIC_MODEL: z.string().min(1).optional(),
    /**
     * The text model stage 9 lifts the narration script with. Its own variable,
     * like every other paid call site, and separate from the voice model below
     * because stage 9 buys from two providers: one writes down what the
     * narrator says, the other says it.
     */
    AIMATOR_NARRATION_MODEL: z.string().min(1).optional(),
    /**
     * The text model stage 4 sends the prompt-package prompt to. Its own
     * variable, like every other paid call site: one shared with stage 1 or 3
     * would mean that choosing a model for the screenplay quietly chose one for
     * the package too, and nobody decided that. No default, for the same reason
     * none of the others has one.
     */
    AIMATOR_PROMPTS_MODEL: z.string().min(1).optional(),
    /**
     * The text model stage 1 sends the screenplay prompt to. Optional because
     * `--dry-run` has to work without it, and because a default here would be
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
    /**
     * The text model stage 10 writes the cue sheet with. Its own variable, like
     * every other paid call site, and separate from the two audio models above
     * for the reason stage 9's text model is separate from its voice: one
     * decides what the episode should sound like, the others make the sound.
     */
    AIMATOR_SOUND_MODEL: z.string().min(1).optional(),
    /**
     * The video model stage 7 renders every clip with, **one variable, not one
     * per track**, unlike the image models above.
     *
     * The per-track rule exists because the two tracks are *drawn* side by side
     * by two different image models, and a shared variable would make running
     * both from one shell an edit between commands. A clip is not drawn: it is
     * rendered from a frame that track already produced, by a model chosen
     * once. So the axis here is the call site, as it is for every text stage,
     * and the tracks still differ in the only way that matters, a clip starts
     * on its own track's entry frame.
     *
     * Optional because `--dry-run` has to work without it, and without a
     * default because a model nobody chose is not a decision.
     */
    AIMATOR_VIDEO_MODEL: z.string().min(1).optional(),
    /**
     * The speech model stage 9 reads the narration with, **one variable for
     * both tracks**, for the reason the video model is one: a spoken sentence
     * is not drawn. A voice reading a line has no idea which of the two films
     * it will sit over, so the axis is the call site.
     *
     * It is the model, never the voice. Which voice reads the series is a
     * creative decision that recurs across episodes, exactly as the cast does,
     * so it lives in `project.json`, a variable would let the second episode
     * get a different narrator from a different shell with nothing on disk
     * saying anybody decided that.
     */
    AIMATOR_VOICE_MODEL: z.string().min(1).optional(),
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
    /** Stage 9's speech key. Read only on the paid path, like every other one. */
    ELEVENLABS_API_KEY: z.string().min(1).optional(),
    /** Read only on the paid path; `--dry-run` never asks for it. */
    OPENAI_API_KEY: z.string().min(1).optional(),
  },
});
