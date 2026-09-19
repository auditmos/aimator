/**
 * Stage 7 — the clips. The first stage that buys two kinds of media, and the
 * first whose gate is a chain rather than a graph.
 *
 * It consumes the approved prompt package together with `prompts/clips/Cnn.md`
 * and `prompts/entry-frames/Cnn.md`, the project rules, the approved shot list —
 * whose clips travel verbatim, and whose planned seconds are what the request
 * orders — and, per clip, the one frame that clip starts on, accepted on *this*
 * track. It produces `episodes/<id>/<track>/clips/Cnn.mp4` and
 * `episodes/<id>/<track>/frames/Cnn/`, with one `clips.stage.json` holding both
 * media and one archive per attempt under that track's `runs/`.
 *
 * Four things are worth knowing before reading further.
 *
 * **Every clip after the first has an entry frame, and the shot list decides
 * what it is drawn from, not whether it is drawn.** `Reference:
 * previous-end-frame` means that frame is drawn from the accepted end of the
 * clip before it, which leads its attachment list; `new-scene-frame` means it
 * is drawn from its own references alone. The first clip has no entry frame of
 * its own — the opening frame is it — which is exactly why stage 4 publishes an
 * entry-frame direction for every clip except the first.
 *
 * **A clip's paid call carries one image: the frame it begins on.** That is the
 * provider's rule and not a preference — pinning a first frame and attaching
 * reference images are mutually exclusive modes. The references a clip names in
 * the manifest are not lost: they are what its entry frame was drawn from.
 *
 * **The end frame comes back with the clip.** The job is asked to return the
 * final frame, so it is published in the same step, out of the same paid
 * attempt, as an output of the same record — which is what lets one review
 * cover the clip and the frame the next one continues out of.
 *
 * **A duration the model cannot render is refused before the POST.** The shot
 * list may plan any length its `maxClipSeconds` allows; the model renders a
 * narrower range, and rounding a plan somebody approved would change the film's
 * timing on nobody's authority. The refusal names the remedy, which is upstream.
 *
 * There is no `--republish`: this stage publishes exactly the bytes the
 * provider returned, so it has no renderer whose mistake would need undoing. A
 * bought answer that failed to publish is already free to retry — the record
 * keeps its job id and repeating the command collects it.
 */

export { type ClipsReport, generateClips } from "./generate.js";
export { approveClips, type ClipsStatus, checkClips } from "./review.js";
