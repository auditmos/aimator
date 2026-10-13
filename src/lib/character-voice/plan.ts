import { z } from "zod";
import {
  applyWrites,
  emptyStage,
  exists,
  type RecordedFile,
  readDigest,
  readJson,
  type StageFile,
  serialize,
  stageFileSchema,
  toWorkspacePath,
  type WriteMode,
} from "../artifact/index.js";
import { showProject } from "../project/index.js";
import { err, ok, type Result } from "../result.js";
import {
  type CharacterVoicePaths,
  characterPaths,
  characterVoicePaths,
  projectPaths,
  type Workspace,
} from "../workspace.js";

/**
 * Internal to the character-voice module: what a voice is, where it lives, and
 * what reading one returns.
 *
 * The decision is one file per character per language, `voice.json`, and not a
 * field of `project.json`: that file is a recorded input of nearly every
 * artifact in the workspace, and a voice is an input of the speech bought in it
 * and of nothing else. Where a decision lives decides what changing it lapses.
 */

/** The one stage name this module writes and reads. */
export const STAGE = "voice";

/** The one artifact a voice has: the sample bought to hear it. */
export const SAMPLE = "sample";

export interface VoiceScope {
  readonly characterId: string;
  /** The language this voice speaks; a directory level, as a track is. */
  readonly language: string;
  readonly projectId: string;
  readonly workspace: Workspace;
}

const voiceFileSchema = z.strictObject({ voiceId: z.string().min(1) });

/** A cast member the roster does not hold, or a voice nobody chose. */
export class VoiceStateError extends Error {
  readonly problems: readonly string[];

  constructor(message: string, problems: readonly string[] = []) {
    super(
      problems.length === 0 ? message : `${message}\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
    this.name = "VoiceStateError";
    this.problems = problems;
  }
}

/** The voice as recorded, with the digest a sample binds itself to. */
export interface RecordedVoice {
  readonly file: RecordedFile;
  readonly voiceId: string;
}

export interface VoiceInputs {
  readonly paths: CharacterVoicePaths;
  /** This voice's own stage file, empty when nothing was bought yet. */
  readonly stage: StageFile;
  /** Null while nobody chose, which blocks a purchase rather than defaulting. */
  readonly voice: RecordedVoice | null;
}

/**
 * Where this voice lives, once the project and its roster say the character
 * exists. A cast member is checked rather than assumed, so a mistyped id is
 * named as one instead of surfacing later as a voice nobody chose.
 */
async function resolvePaths(input: VoiceScope): Promise<Result<CharacterVoicePaths>> {
  const project = projectPaths(input.workspace, input.projectId);

  if (!project.ok) {
    return project;
  }

  const character = characterPaths(project.data, input.characterId);

  if (!character.ok) {
    return character;
  }

  const shown = await showProject(input);

  if (!shown.ok) {
    return shown;
  }

  if (!shown.data.cast.some((member) => member.id === input.characterId)) {
    return err(
      new VoiceStateError(
        `postać "${input.characterId}" nie jest w obsadzie projektu "${input.projectId}", zadeklaruj ją przez: aimator character new ${input.projectId} ${input.characterId} --name "..."`
      )
    );
  }

  return characterVoicePaths(character.data, input.language);
}

/** Everything a decision, a purchase or a check reads, in one call. */
export async function readVoiceInputs(input: VoiceScope): Promise<Result<VoiceInputs>> {
  const paths = await resolvePaths(input);

  if (!paths.ok) {
    return paths;
  }

  const stage = await readJson(paths.data.stage, stageFileSchema);
  const base = { paths: paths.data, stage: stage.ok ? stage.data : emptyStage(STAGE) };

  if (!(await exists(paths.data.file))) {
    return ok({ ...base, voice: null });
  }

  const file = await readJson(paths.data.file, voiceFileSchema);
  const digest = await readDigest(paths.data.file);

  if (!file.ok) {
    return file;
  }
  if (!digest.ok) {
    return digest;
  }

  return ok({
    ...base,
    voice: {
      file: {
        path: toWorkspacePath(input.workspace.root, paths.data.file),
        sha256: digest.data.sha256,
      },
      voiceId: file.data.voiceId,
    },
  });
}

/** What `character voice` decided, and what it wrote or would write. */
export interface VoiceDecision {
  readonly characterId: string;
  readonly language: string;
  readonly nextStep: string;
  readonly problems: readonly string[];
  readonly voiceId: string;
  /** Workspace-relative; under `--dry-run`, what would have been written. */
  readonly written: readonly string[];
}

type SetVoiceInput = VoiceScope & { readonly mode: WriteMode; readonly voiceId: string };

/**
 * Casts a character's voice in one language. Free, and nothing but the file:
 * the provider's id is recorded verbatim, because this tool cannot tell a real
 * id from a typo and a sample is how a person finds out.
 */
export async function setVoice(input: SetVoiceInput): Promise<Result<VoiceDecision>> {
  const voiceId = input.voiceId.trim();

  if (voiceId === "") {
    return err(new VoiceStateError("--voice-id jest pusty, a głosu nie wybiera się domyślnie"));
  }

  const inputs = await readVoiceInputs(input);

  if (!inputs.ok) {
    return inputs;
  }

  const { paths, stage, voice } = inputs.data;
  const written = await applyWrites(
    [{ kind: "text", text: serialize({ voiceId }), to: paths.file }],
    input.mode
  );

  if (!written.ok) {
    return written;
  }

  const sample = stage.artifacts[SAMPLE];
  const sampleScope = `${input.projectId} ${input.characterId} --language ${input.language} --text "<zdanie>"`;
  // A sample read in the voice being replaced is a recording of somebody
  // else. Said here, at the moment it happens, rather than left to `check`.
  const replaced = sample !== undefined && voice !== null && voice.voiceId !== voiceId;

  return ok({
    characterId: input.characterId,
    language: input.language,
    nextStep: replaced
      ? `kup próbkę nowego głosu: aimator character sample ${sampleScope} --regenerate`
      : `posłuchaj głosu, zaczynając od podglądu: aimator character sample ${sampleScope} --dry-run`,
    problems: replaced
      ? [
          `próbka ${input.language} czyta poprzedni głos ${voice.voiceId}${sample.review.status === "approved" ? ", zgoda na próbkę wygasła" : ""}; inne języki i inne etapy zostają nietknięte`,
        ]
      : [],
    voiceId,
    written: written.data.map((path) => toWorkspacePath(input.workspace.root, path)),
  });
}
