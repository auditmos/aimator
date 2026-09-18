/**
 * Stage 5 — reference images. The first stage where the two tracks really part
 * company: one package, two independent sets of images, two separate reviews.
 *
 * It consumes the approved prompt package and produces
 * `episodes/<id>/<track>/references/Rxx.png`, with one
 * `references.stage.json` per track holding every reference as its own record,
 * and one archive per attempt under that track's `runs/`.
 *
 * Three things make it different from every stage before it.
 *
 * The gate is **inside its own set of results**: R04 waits for R03 and R06 for
 * R01 and R02, each accepted on *this* track. Nothing upstream had a dependency
 * on its own output.
 *
 * One command can therefore buy **several** images, because the graph has more
 * than one runnable root at a time. Stage 2 drew one step per invocation, but
 * that was a consequence of its gates rather than a rule, so the report here
 * states how many paid calls it is about to make instead of pretending there is
 * only ever one.
 *
 * And it owns almost no logic of its own. What a reference is drawn from and
 * whether those images were accepted is `lib/media-prompt`; the order of
 * operations around the POST is `lib/image-model`; the verdict on the bytes is
 * the same one stage 2 uses. What is left is which references to draw, the lock
 * around them, and the review.
 *
 * There is no `--republish`: this stage publishes exactly the bytes the
 * provider returned, so it has no renderer whose mistake would need undoing. A
 * bought answer that failed to publish is already free to retry — the record
 * stays `submitted` and repeating the command finishes it from the archive.
 */

export {
  generateReferences,
  type ReferencesReport,
} from "./generate.js";
export {
  approveReferences,
  checkReferences,
  type ReferencesStatus,
} from "./review.js";
