/**
 * One billed video job, and what the video model accepts.
 *
 * A clip is not a fourth caller of `lib/image-model`, and `AGENTS.md` says why:
 * a video is an asynchronous job with an id to poll, which is a different order
 * of operations from a request that answers with the picture. The lifecycle is
 * the module, and a flag in the image module would have hidden that.
 *
 * What lives here is everything true of *any* clip a stage buys: the endpoint,
 * how a job is submitted, polled and downloaded, what the provider hands back
 * beside the clip, how long a clip may be, and the verdict on the bytes.
 *
 * What stays with the stage is everything about *its* artifact: the prompt, the
 * frame it starts from, the shots it belongs to, where the file goes and the
 * words it uses for a refusal.
 *
 * One model renders both tracks, which is a decision the user stores in one
 * variable rather than a fact about a track. The tracks still differ, in the
 * only way that matters here: the entry frame a clip starts from is drawn by
 * that track's image model, from that track's own references.
 */

export { runVideoStage } from "./attempt.js";
export { clipDuration, validateEndFrame, validateVideo } from "./validate.js";
