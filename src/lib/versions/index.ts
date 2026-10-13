/**
 * Stage 12, language versions. The film's mouths moved to a second language,
 * one track at a time.
 *
 * It consumes the episode's `lip-sync.json`, the accepted translation and its
 * bought lines from stage 11, and this track's accepted clips from stage 7. It
 * produces `<track>/versions/`: the faces found in each clip, a person's word
 * on who each face is, and each clip lip-synced, with a `versions.stage.json`
 * beside it.
 */

export { type BindingReport, bindFaces, type FacesReport, findFaces } from "./faces.js";
export { type FinalReport, generateFinal } from "./final.js";
export { generateLipSync, type LipSyncReport } from "./generate.js";
export { approveVersions, checkVersions, type VersionsStatus } from "./review.js";
