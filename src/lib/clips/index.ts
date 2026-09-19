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
 * cover the clip and the frame the next one continues out of. Its format is the
 * provider's choice, so the file is named after what it holds: `end.jpg` for the
 * JPEG ModelArk returns, `end.png` if a provider ever returns one.
 *
 * **A duration the model cannot render is refused before the POST.** The shot
 * list may plan any length its `maxClipSeconds` allows; the model renders a
 * narrower range, and rounding a plan somebody approved would change the film's
 * timing on nobody's authority. The refusal names the remedy, which is upstream.
 *
 * **`--republish` exists here, and only for clips.** Stages 5 and 6 have none
 * because they publish exactly the bytes the provider returned; this one
 * decides something as well — what the still that came back with the clip is,
 * and what to call it — and a mistake in that decision surfaces *after*
 * publication, on a record that already says `completed`. The contract is
 * explicit that a bought answer must stay re-derivable for free, so the clip is
 * published again from its archive, sending nothing. An entry frame is drawn
 * exactly as the image model drew it, so there is nothing there to undo.
 */

export { type ClipsReport, generateClips } from "./generate.js";
export { approveClips, type ClipsStatus, checkClips } from "./review.js";
