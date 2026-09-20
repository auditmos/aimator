/**
 * Stage 8 — the assembly. The last row of the table, the first stage that buys
 * nothing, and the first whose bytes come from a local engine.
 *
 * It consumes the approved shot list and every clip that list plans, accepted
 * on *this* track, and produces `episodes/<id>/<track>/episode.mp4` with an
 * `assembly.stage.json` beside it and one thin archive under that track's
 * `runs/`.
 *
 * Five things are worth knowing before reading further.
 *
 * **The edit plan is derived, not stored.** The contract named an
 * `edit-plan.json` among this stage's inputs and no stage ever wrote one —
 * because everything it could hold is already in the approved shot list: the
 * order, the absolute seconds, and the guarantee that the clips tile the
 * episode without a gap. A second file would be `shot-list.json` under another
 * name, which stages 3 and 4 both refused for the reason that decides it here
 * too: two files holding one truth drift at the first hand correction, and the
 * one a human corrects is the other one.
 *
 * **The gate is the table's own sentence — approved clips.** Every clip the
 * plan names, finished and accepted on this track. Entry frames and end frames
 * are not asked after: an entry frame is already the first frame of its clip,
 * and an end frame is what the chain above needed rather than what the edit
 * cuts.
 *
 * **What came back is what is cut.** Clips do not return to the second — a 24
 * fps renderer leaves a fraction over — and stage 7 publishes them as they
 * arrived rather than trimming. Those are the bytes a human accepted, so
 * trimming them here would assemble a film out of frames nobody approved. The
 * difference from the approved plan is stated in the report and the verdict on
 * the finished file compares it against the sum of its own clips, never against
 * the episode's declared duration.
 *
 * **It copies, it never re-encodes, and it has no second road.** Both tracks
 * render at one resolution and frame rate from one video model, so a stream
 * copy is genuinely available; where it is not, this refuses. A missing ffmpeg
 * is a refusal that names the remedy rather than a fallback, because a muxer
 * written here would be a container writer this repository would then have to
 * trust — the thing stage 7 avoided by reading boxes. `check` needs none of it:
 * it reads `episode.mp4`'s own boxes, offline, like every verdict in this tool.
 *
 * **The cut is silent, and says so.** The episode stored a sound mode in stage
 * 0 and no stage produces a soundtrack: a track continuous across cuts cannot
 * be made by a model that hears one clip at a time, and — the sharper reason —
 * it has to be written against the film that exists rather than against the
 * plan, which is this stage's output and not its input. So it belongs below
 * this row, not inside it, and `episode.mp4` is the picture cut. That is
 * reported at every `check`, never hidden and never enforced.
 */

export { type AssemblyReport, generateAssembly } from "./generate.js";
export { type AssemblyStatus, approveAssembly, checkAssembly } from "./review.js";
