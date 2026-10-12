import { err, ok, type Result } from "../result.js";
import type { VideoRequest } from "./client.js";
import { kling } from "./kling.js";
import { modelArk } from "./modelark.js";
import type { VideoTask } from "./validate.js";

/**
 * Internal to the video-model module: which provider renders a model, and what
 * each one accepts.
 *
 * The table is **closed** on purpose. The model id is the user's decision, and
 * it already says who renders it, `dreamina-seedance-*` is BytePlus ModelArk and
 * `kling-3.0` is Kling, so a second variable naming the provider would be a
 * second copy of one truth. An id outside the table is refused before anything
 * is sent, because guessing an endpoint for a model nobody listed is a way of
 * paying for a request that was never going to work.
 *
 * A row is everything that differs between two providers of the same kind of
 * call: the wire, the limits, the key and where the end frame comes from. The
 * order of operations around the job is not in a row, because it does not
 * differ; it is `attempt.ts`, once.
 */

/** The environment variable each provider's key lives in. */
export type VideoKey = "BYTEPLUS_MODELARK" | "KLING_API_KEY";

export interface VideoProvider {
  /** The request as archived: every setting sent, the frame by digest only. */
  readonly archive: (request: VideoRequest) => unknown;
  /** The request as sent. */
  readonly body: (request: VideoRequest) => unknown;
  /**
   * Where the frame the clip ends on comes from: handed back beside the clip,
   * or cut out of the downloaded clip on this machine, which needs ffmpeg.
   */
  readonly endFrame: "cut" | "returned";
  readonly endpoint: (model: string) => string;
  readonly key: VideoKey;
  /** How a model id is recognised as this provider's. */
  readonly matches: (model: string) => boolean;
  /** How the id is written in a refusal: what a person may type instead. */
  readonly pattern: string;
  readonly pollUrl: (jobId: string) => string;
  /** The longest prompt the provider takes, in characters; `null` for no stated limit. */
  readonly promptLimit: number | null;
  readonly readSubmit: (body: string) => Result<string>;
  readonly readTask: (body: string) => Result<VideoTask>;
  /** What the provider renders, in whole seconds, inclusive. */
  readonly seconds: { readonly max: number; readonly min: number };
}

const PROVIDERS: readonly VideoProvider[] = [modelArk, kling];

class VideoModelError extends Error {
  readonly model: string;

  constructor(model: string, message: string) {
    super(message);
    this.name = "VideoModelError";
    this.model = model;
  }
}

class DurationError extends Error {
  readonly seconds: number;

  constructor(seconds: number, message: string) {
    super(message);
    this.name = "DurationError";
    this.seconds = seconds;
  }
}

export function providerOf(model: string): Result<VideoProvider> {
  const found = PROVIDERS.find((one) => one.matches(model));

  return found === undefined
    ? err(
        new VideoModelError(
          model,
          `nieznany model wideo "${model}", znane: ${PROVIDERS.map((one) => one.pattern).join(", ")}`
        )
      )
    : ok(found);
}

class PromptLengthError extends Error {
  readonly characters: number;

  constructor(characters: number, message: string) {
    super(message);
    this.name = "PromptLengthError";
    this.characters = characters;
  }
}

/**
 * Whether the model takes a prompt this long.
 *
 * Counted in characters, the way the provider states its limit, and refused
 * rather than cut: a prompt is composed from stage 4's direction and the shot
 * list's verbatim words, and dropping its end would send a clip a direction
 * nobody approved. The remedy is upstream, and the message says where.
 */
export function clipPrompt(prompt: string, model: string): Result<string> {
  const provider = providerOf(model);

  if (!provider.ok) {
    return provider;
  }

  const characters = [...prompt].length;
  const limit = provider.data.promptLimit;

  return limit === null || characters <= limit
    ? ok(prompt)
    : err(
        new PromptLengthError(
          characters,
          `prompt klipu ma ${characters} znaków, a model ${model} przyjmuje najwyżej ${limit}; skróć kierunek klipu w pakiecie promptów (etap 4) albo opis klipu na liście ujęć (etap 3)`
        )
      );
}

/**
 * What a stage has to know about a model before it may pay: whose key the call
 * needs, and whether the end frame is cut on this machine, which needs ffmpeg.
 * The wire stays in here.
 */
interface VideoModel {
  readonly endFrame: VideoProvider["endFrame"];
  readonly key: VideoKey;
}

/** The model's row in the table, narrowed to what a stage reads; a refusal off it. */
export function videoModel(model: string): Result<VideoModel> {
  const provider = providerOf(model);

  return provider.ok ? ok({ endFrame: provider.data.endFrame, key: provider.data.key }) : provider;
}

function range(provider: VideoProvider): string {
  return `${provider.seconds.min} do ${provider.seconds.max}s`;
}

/**
 * Whether the model will render a clip of this length.
 *
 * Refused rather than rounded, for the reason `frameSize` refuses a ratio no
 * track renders: the shot list is an approved decision, and a tool that
 * silently ordered fifteen seconds where a human planned fourteen would be
 * changing the film's timing on nobody's authority. The remedy is upstream,
 * a different `maxClipSeconds` and a re-planned shot list, and the message
 * says so, because that is a decision the person makes, not the tool.
 *
 * `model: null` is the question `check` asks, which has no model in hand: a
 * length is refused there only when no model in the table renders it, because
 * anything less would call a plan broken that one `--video-model` would buy.
 */
export function clipDuration(seconds: number, model: string | null): Result<number> {
  if (!Number.isInteger(seconds)) {
    return err(
      new DurationError(seconds, `długość klipu ${seconds}s nie jest pełną liczbą sekund`)
    );
  }

  if (model !== null) {
    const chosen = providerOf(model);

    if (!chosen.ok) {
      return chosen;
    }

    return renders(chosen.data, seconds)
      ? ok(seconds)
      : err(
          new DurationError(
            seconds,
            `klip trwa ${seconds}s, a model ${model} renderuje od ${range(chosen.data)}, ${REMEDY}`
          )
        );
  }

  return PROVIDERS.some((one) => renders(one, seconds))
    ? ok(seconds)
    : err(
        new DurationError(
          seconds,
          `klip trwa ${seconds}s, a żaden model wideo tego nie renderuje (${PROVIDERS.map((one) => `${one.pattern}: od ${range(one)}`).join(", ")}), ${REMEDY}`
        )
      );
}

const REMEDY =
  "zmień maxClipSeconds odcinka i przeplanuj listę ujęć (etap 3), bo tego narzędzie nie zaokrągli za ciebie";

function renders(provider: VideoProvider, seconds: number): boolean {
  return seconds >= provider.seconds.min && seconds <= provider.seconds.max;
}
