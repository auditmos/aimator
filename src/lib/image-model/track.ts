import { err, ok, type Result } from "../result.js";
import type { ImageTrack } from "../workspace.js";

/**
 * Internal to the image-model module: what each track accepts.
 *
 * Two provider facts live here, and nothing else does. Both are limits rather
 * than decisions, which is why they are constants with no flag and no stored
 * value: nobody chooses how many reference images an API takes.
 */

/**
 * How many reference images a track carries in one request. Exceeding it is
 * refused rather than trimmed, for the reason stage 2 already states: a plan a
 * human accepted is not a list the tool gets to shorten on their behalf.
 */
const MAX_REFERENCES: Record<ImageTrack, number> = { "gpt-image": 16, seedream: 10 };

/** gpt-image 2.5 wants both sides divisible by 16; seedream does not mind. */
const STEP = 16;
/** The tighter of the two floors and ceilings, so one frame serves both tracks. */
const MIN_AREA = 921_600;
const MAX_AREA = 4_624_220;
const MAX_EDGE = 3840;
const MIN_RATIO = 1 / 3;
const MAX_RATIO = 3;

const RATIO = /^(\d{1,4}):(\d{1,4})$/;

class FrameError extends Error {
  readonly aspectRatio: string;

  constructor(aspectRatio: string, message: string) {
    super(message);
    this.name = "FrameError";
    this.aspectRatio = aspectRatio;
  }
}

export function referenceLimit(track: ImageTrack): number {
  return MAX_REFERENCES[track];
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

/**
 * The film frame of an episode, in pixels, from the project's `aspectRatio`.
 *
 * Derived rather than stored, and the same on both tracks. `aspectRatio` is
 * already an explicit stage-0 decision with no default, so rule 7 is satisfied
 * without a second field nobody would know how to answer: what is missing from
 * `16:9` is only the arithmetic that turns a ratio into pixels two providers
 * both accept, and arithmetic is not a decision.
 *
 * It returns the **largest** such frame. A reference is drawn once and read by
 * every later call that attaches it, so resolution given up here cannot be
 * recovered downstream, while a model that wants fewer pixels can always be
 * given fewer. The ratio is held exactly: an approximation would quietly hand
 * back a frame the episode did not ask for.
 *
 * A ratio neither track can render is refused rather than rounded into one
 * they can. That is the same refusal the reference limit makes, one level up.
 *
 * It answers in the request's own spelling — `2816x1584` — because that is what
 * both providers take and what the PNG verdict compares against. Width and
 * height never travel apart, so they are never handed over apart.
 */
export function frameSize(aspectRatio: string): Result<string> {
  const match = RATIO.exec(aspectRatio.trim());

  if (match === null) {
    return err(
      new FrameError(aspectRatio, `niepoprawne proporcje obrazu "${aspectRatio}" — oczekiwano w:h`)
    );
  }

  const parsedWidth = Number(match[1]);
  const parsedHeight = Number(match[2]);

  if (parsedWidth < 1 || parsedHeight < 1) {
    return err(new FrameError(aspectRatio, `proporcje "${aspectRatio}" mają zerowy bok`));
  }

  const ratio = parsedWidth / parsedHeight;

  if (ratio < MIN_RATIO || ratio > MAX_RATIO) {
    return err(
      new FrameError(
        aspectRatio,
        `proporcje "${aspectRatio}" leżą poza zakresem, jaki przyjmują tory obrazowe (od 1:3 do 3:1) — zmień aspectRatio projektu, bo narzędzie nie zaokrągli kadru za ciebie`
      )
    );
  }

  const divisor = greatestCommonDivisor(parsedWidth, parsedHeight);
  const unitWidth = parsedWidth / divisor;
  const unitHeight = parsedHeight / divisor;
  // The smallest exact-ratio frame whose sides are both multiples of 16: the
  // least multiplier that clears the step for each side at once.
  const forWidth = STEP / greatestCommonDivisor(STEP, unitWidth);
  const forHeight = STEP / greatestCommonDivisor(STEP, unitHeight);
  const step = (forWidth * forHeight) / greatestCommonDivisor(forWidth, forHeight);
  const baseWidth = unitWidth * step;
  const baseHeight = unitHeight * step;
  const byArea = Math.sqrt(MAX_AREA / (baseWidth * baseHeight));
  const byEdge = MAX_EDGE / Math.max(baseWidth, baseHeight);
  const scale = Math.floor(Math.min(byArea, byEdge));

  if (scale < 1) {
    return err(
      new FrameError(
        aspectRatio,
        `proporcje "${aspectRatio}" nie mieszczą się w limitach żadnego kadru, jaki oba tory przyjmują`
      )
    );
  }

  const width = baseWidth * scale;
  const height = baseHeight * scale;

  return width * height < MIN_AREA
    ? err(
        new FrameError(
          aspectRatio,
          `największy kadr o proporcjach "${aspectRatio}" ma ${width}x${height}, czyli mniej niż minimum toru seedream`
        )
      )
    : ok(`${width}x${height}`);
}
