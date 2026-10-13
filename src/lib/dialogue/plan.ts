import {
  emptyStage,
  type RecordedFile,
  readDigest,
  readJson,
  type StageFile,
  stageFileSchema,
  toWorkspacePath,
} from "../artifact/index.js";
import { checkVoice } from "../character-voice/index.js";
import { type CastMember, readStage0Inputs } from "../project/index.js";
import { ok, type Result } from "../result.js";
import { checkShotList, type ShotList } from "../shot-list/index.js";
import {
  characterPaths,
  characterVoicePaths,
  type EpisodePaths,
  episodePaths,
  projectPaths,
  type Workspace,
} from "../workspace.js";
import { buildPrompt } from "./prompt.js";

/**
 * Internal to the dialogue module: what stage 11 reads, and whether it may pay.
 *
 * One gate for the script, and it has two halves. The plan has to be accepted,
 * because every line comes out of it; and the episode has to be one in which
 * characters speak, because buying a dialogue script for a film without
 * dialogue would be paying to be told there is nothing to lift.
 *
 * The voices are a second gate, and a narrower one. They gate buying a line,
 * not reading which lines exist, the same split stage 9 makes between its
 * script and its recordings, and each voice gates only its own speaker's
 * lines: a character nobody has heard yet holds back what that character says
 * and nothing anybody else does.
 */

/** The one stage name this module writes and reads. */
export const STAGE = "dialogue";

/** The artifact key of the script, beside which the bought lines will sit. */
export const SCRIPT = "script";

export interface Stage11Scope {
  readonly episodeId: string;
  readonly projectId: string;
  readonly workspace: Workspace;
}

export class Stage11BlockedError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`etap 11 nie może tego zrobić:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "Stage11BlockedError";
    this.problems = problems;
  }
}

export interface Stage11Inputs {
  /** The roster's ids, which name who may speak. */
  readonly cast: readonly CastMember[];
  readonly episode: EpisodePaths;
  /** Why the script may not be bought yet. Empty means it may. */
  readonly gate: readonly string[];
  /** project.json, project.md, episode.json and shot-list.md, with digests. */
  readonly inputs: readonly RecordedFile[];
  /** The film's language: what the lines are spoken in, and so which voice reads them. */
  readonly language: string;
  /** The approved plan as data, or null while it does not validate. */
  readonly plan: ShotList | null;
  /** The exact text a paid call would send, or `null` when it cannot be built. */
  readonly prompt: string | null;
  readonly stage: StageFile;
}

/**
 * Everything stage 11's script consumes, with the digest of each file as it was
 * read. `source.md` is left out for stage 3's reason: nothing here sends it.
 */
export async function readStage11Inputs(input: Stage11Scope): Promise<Result<Stage11Inputs>> {
  const project = projectPaths(input.workspace, input.projectId);

  if (!project.ok) {
    return project;
  }

  const episode = episodePaths(project.data, input.episodeId);

  if (!episode.ok) {
    return episode;
  }

  const stage0 = await readStage0Inputs(input);

  if (!stage0.ok) {
    return stage0;
  }

  const relative = (path: string): string => toWorkspacePath(input.workspace.root, path);
  const gate: string[] = [];
  const { audio } = stage0.data.settings;

  if (audio !== "dialogue" && audio !== "dialogue-and-narration") {
    gate.push(
      `odcinek deklaruje audio: ${audio}, ten odcinek nie ma dialogu, etap 11 nie ma czego podnosić`
    );
  }

  // One gate covers stages 0 and 1 arithmetically, as stage 9's does: they are
  // recorded inputs of the shot list, so editing one revokes its approval.
  const upstream = await checkShotList(input);

  if (!upstream.ok) {
    return upstream;
  }

  if (!upstream.data.approved) {
    gate.push(...upstream.data.problems);
    gate.push(
      `etap 3 musi mieć review.status = "approved" zanim etap 11 wyda pieniądze: aimator approve ${input.projectId} ${input.episodeId} --stage shot-list`
    );
  }

  const plan = upstream.data.verdict;

  // A plan accepted before stage 3 wrote lines with their speaker carries none,
  // and a script lifted from it would be bought to say exactly that.
  if (plan !== null && gate.length === 0 && plan.shots.every((shot) => shot.lines.length === 0)) {
    gate.push(
      `lista ujęć nie przypisuje żadnej kwestii postaci, zapis <id>: "…" dostaje przy: aimator shot-list generate ${input.projectId} ${input.episodeId} --regenerate`
    );
  }

  const shotList = await readDigest(episode.data.shotList);

  if (!shotList.ok) {
    gate.push(`brakuje ${relative(episode.data.shotList)}, etap 11 nie ma z czego podnosić`);
  }

  const stage = await readJson(episode.data.dialogueStage, stageFileSchema);
  const sourcePath = relative(episode.data.source);

  return ok({
    cast: stage0.data.cast,
    episode: episode.data,
    gate,
    inputs: [
      ...stage0.data.inputs.filter((entry) => entry.path !== sourcePath),
      ...(shotList.ok
        ? [{ path: relative(episode.data.shotList), sha256: shotList.data.sha256 }]
        : []),
    ],
    language: stage0.data.settings.language,
    plan,
    prompt: shotList.ok
      ? buildPrompt({
          cast: stage0.data.cast,
          rules: stage0.data.rules,
          settings: stage0.data.settings,
          shotList: shotList.data.bytes.toString("utf8"),
        })
      : null,
    stage: stage.ok ? stage.data : emptyStage(STAGE),
  });
}

/** One speaker's voice in the film's language, as far as buying a line in it goes. */
export interface SpeakerVoice {
  /** The `voice.json` a line bought in it records, or null while nobody chose one. */
  readonly file: RecordedFile | null;
  /** Why no line of this speaker may be bought yet; null when one may. */
  readonly obstacle: string | null;
  readonly voiceId: string | null;
}

/**
 * The voice of every speaker, keyed by cast id.
 *
 * Answered through `checkVoice`, so a voice counts as accepted here exactly when
 * its own check says so: a sample read in a voice that has since been replaced
 * is a recording of somebody else, and buying lines on its approval would buy
 * a voice nobody heard.
 */
export async function readVoices(
  input: Stage11Scope,
  speakers: readonly string[],
  language: string
): Promise<Result<ReadonlyMap<string, SpeakerVoice>>> {
  const project = projectPaths(input.workspace, input.projectId);

  if (!project.ok) {
    return project;
  }

  const voices = new Map<string, SpeakerVoice>();

  for (const characterId of new Set(speakers)) {
    const scope = { ...input, characterId, language };
    // biome-ignore lint/performance/noAwaitInLoops: one speaker at a time, in the order they speak
    const status = await checkVoice(scope);
    const paths = characterPaths(project.data, characterId);
    const voice = paths.ok ? characterVoicePaths(paths.data, language) : paths;

    if (!status.ok) {
      return status;
    }
    if (!voice.ok) {
      return voice;
    }

    const digest = await readDigest(voice.data.file);

    voices.set(characterId, {
      file: digest.ok
        ? {
            path: toWorkspacePath(input.workspace.root, voice.data.file),
            sha256: digest.data.sha256,
          }
        : null,
      obstacle: status.data.approved
        ? null
        : `głos postaci "${characterId}" (${language}) nie ma przyjętej próbki: ${status.data.nextStep}`,
      voiceId: status.data.voiceId,
    });
  }

  return ok(voices);
}
