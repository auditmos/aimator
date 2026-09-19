/**
 * Stage 6 — the opening frame. The first frame of the film, and the first
 * artifact whose gate reads another stage's per-track results.
 *
 * It consumes the approved prompt package together with
 * `prompts/opening-frame.md`, the project rules, the approved shot list — whose
 * first clip's shots travel verbatim, because this is a frame of the film and
 * not a reference — and the images its manifest entry names, accepted on *this*
 * track. It produces `episodes/<id>/<track>/opening-frame.png`, with one
 * `opening-frame.stage.json` beside it and one archive per attempt under that
 * track's `runs/`.
 *
 * Almost nothing here is its own. The attachment list, the gate on it and the
 * composed prompt are `lib/media-prompt`; the order of operations around the
 * POST is `lib/image-model`; the verdict on the bytes is the one stages 2 and 5
 * already use. What is left is a lock, a review and the words for a refusal —
 * which is the shape a stage is supposed to have by now, and the reason this one
 * cost a fraction of what stage 5 did.
 *
 * Two differences from stage 5 are worth knowing before reading further.
 *
 * There is exactly **one** artifact, so `--artifact` narrows nothing and is not
 * required anywhere: not on `--regenerate`, which has one image it could mean,
 * and not on `approve`, where the command already names the stage and the track.
 * Stage 5 requires it because it has six candidates and accepting the wrong one
 * buys an image; a flag with a single legal value would be ceremony standing
 * where a decision used to be.
 *
 * And its dependency crosses a **stage** boundary without crossing a track one.
 * Stage 5's graph waited on references it had drawn itself; the opening frame
 * waits on `R01` accepted on this track and on `hero:ewa` accepted on this
 * track, which is why an approval on gpt-image opens nothing for seedream.
 *
 * There is no `--republish`: this stage publishes exactly the bytes the provider
 * returned, so it has no renderer whose mistake would need undoing. A bought
 * answer that failed to publish is already free to retry — the record stays
 * `submitted` and repeating the command finishes it from the archive.
 */

export { generateOpeningFrame, type OpeningFrameReport } from "./generate.js";
export {
  approveOpeningFrame,
  checkOpeningFrame,
  type OpeningFrameStatus,
} from "./review.js";
