import {
  type RecordedFile,
  readDigest,
  readJson,
  type StageFile,
  stageFileSchema,
  toWorkspacePath,
} from "../artifact/index.js";
import { checkCharacter } from "../character/index.js";
import { frameSize, referenceLimit } from "../image-model/index.js";
import { type CastMember, readStage0Inputs } from "../project/index.js";
import { checkPromptPackage, type PromptPackage } from "../prompt-package/index.js";
import { err, ok, type Result } from "../result.js";
import { checkShotList, type ShotList } from "../shot-list/index.js";
import {
  characterPaths,
  characterTrackPaths,
  type EpisodePaths,
  type EpisodeTrackPaths,
  episodePaths,
  episodeTrackPaths,
  type ImageTrack,
  type ProjectPaths,
  type PromptKind,
  projectPaths,
  promptFile,
  promptPaths,
  referenceImage,
  type Workspace,
} from "../workspace.js";
import { type AttachmentSlot, composePrompt, PROMPT_VERSION } from "./prompt.js";

/**
 * Internal to the media-prompt module: what one future paid call carries, and
 * whether it may be carried yet.
 *
 * Both halves belong together because both are the same question asked twice.
 * The attachment list is the ordered set of images the request will hold; the
 * gate is whether every one of them is an image a human accepted. A sender that
 * resolved the list without asking the second question would attach bytes
 * nobody approved, and a gate that asked it without building the list would be
 * guarding a set it had not seen.
 *
 * This is where the package stops being track-neutral. `hero:ewa` and `R03` are
 * written by stage 4, which names no track on purpose; they become
 * `characters/ewa/<track>/hero.png` and `episodes/<id>/<track>/references/R03.png`
 * here, at the last possible moment. That resolution is the whole reason one
 * manifest serves two productions.
 */

/** How stage 4 writes a reference to a character's canonical image. */
const HERO = "hero:";
const OPENING = "opening-frame";
const ENTRY = "entry:";

export type TargetKind = "clip" | "entry-frame" | "opening" | "reference";

/** One position in the request: which bytes, and whether anyone accepted them. */
export interface Attachment {
  /** The file itself, for the stage that will POST it. `null` when absent. */
  readonly bytes: Buffer | null;
  readonly id: string;
  /** Workspace-relative, so a report can name it and an archive can record it. */
  readonly path: string;
  /** One line of English; it reaches the model in the numbered list. */
  readonly role: string;
  readonly sha256: string | null;
  readonly state: "absent" | "approved" | "changed" | "pending";
}

/** One future paid call, as the package plans it for one track. */
export interface PlannedArtifact {
  readonly attachments: readonly Attachment[];
  /** Why this call may not happen yet. Empty means every input is accepted. */
  readonly blockers: readonly string[];
  /** The stage-file key and the output's own name: `R02`, `C03`, `opening-frame`. */
  readonly id: string;
  /** Everything it consumes, with the digest of each file as it was read. */
  readonly inputs: readonly RecordedFile[];
  readonly kind: TargetKind;
  /** What `--artifact` accepts for this one; an entry frame is `entry:C03`. */
  readonly name: string;
  /** The exact text a paid call would send, or `null` when only summarised. */
  readonly text: string | null;
}

export interface SendPlan {
  readonly artifacts: readonly PlannedArtifact[];
  readonly aspectRatio: string;
  /** How many references this track carries in one request. */
  readonly limit: number;
  /** Why nothing here may be sent at all — an unapproved or unread package. */
  readonly problems: readonly string[];
  /**
   * Which version of this composer wrapped the direction.
   *
   * It travels with the plan rather than being imported beside it, so the
   * version a stage records is necessarily the one that produced the text it
   * sent. The prompt file's own bytes are recorded separately, by digest.
   */
  readonly promptVersion: number;
  /** The film frame both tracks draw this episode in. */
  readonly size: string;
  readonly track: ImageTrack;
}

interface SendPlanInput {
  readonly episodeId: string;
  readonly projectId: string;
  /** Names to compose in full. Empty summarises every artifact and composes none. */
  readonly targets: readonly string[];
  readonly track: ImageTrack;
  readonly workspace: Workspace;
}

class SendPlanError extends Error {
  readonly problems: readonly string[];

  constructor(message: string, problems: readonly string[] = []) {
    super(
      problems.length === 0 ? message : `${message}\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
    this.name = "SendPlanError";
    this.problems = problems;
  }
}

interface Paths {
  readonly episode: EpisodePaths;
  readonly project: ProjectPaths;
  readonly trackPaths: EpisodeTrackPaths;
}

/** What every artifact of one run shares: the plan, the files, the track. */
interface Scope {
  readonly aspectRatio: string;
  readonly cast: readonly CastMember[];
  /** One digest per path per run: heroes appear in nearly every frame. */
  readonly digests: Map<string, { bytes: Buffer; sha256: string } | null>;
  /** One character check per character per run, for the same reason. */
  readonly heroes: Map<string, boolean>;
  readonly input: SendPlanInput;
  /** How many references this track carries in one request. */
  readonly limit: number;
  readonly manifest: PromptPackage;
  readonly paths: Paths;
  readonly rules: string;
  /** The recorded stage-0 and stage-4 files every artifact consumes. */
  readonly shared: readonly RecordedFile[];
  readonly shotList: ShotList;
  readonly size: string;
  /** This track's stage-5 file, or `null` when it has drawn nothing yet. */
  readonly stage: StageFile | null;
}

function resolvePaths(input: SendPlanInput): Result<Paths> {
  const project = projectPaths(input.workspace, input.projectId);

  if (!project.ok) {
    return project;
  }

  const episode = episodePaths(project.data, input.episodeId);

  return episode.ok
    ? ok({
        episode: episode.data,
        project: project.data,
        trackPaths: episodeTrackPaths(episode.data, input.track),
      })
    : episode;
}

/** Reads a file once per run, whatever asks for it. */
async function digestOf(
  scope: Scope,
  path: string
): Promise<{ bytes: Buffer; sha256: string } | null> {
  const cached = scope.digests.get(path);

  if (cached !== undefined) {
    return cached;
  }

  const read = await readDigest(path);
  const value = read.ok ? read.data : null;

  scope.digests.set(path, value);

  return value;
}

/**
 * Whether one character's canonical image is accepted on this track.
 *
 * The verdict comes from `lib/character`, through its entry: whether an image
 * is accepted is that module's question, and a second answer here would be a
 * second opinion about the same file.
 */
async function heroAccepted(scope: Scope, characterId: string): Promise<boolean> {
  const cached = scope.heroes.get(characterId);

  if (cached !== undefined) {
    return cached;
  }

  const status = await checkCharacter({
    characterId,
    projectId: scope.input.projectId,
    track: scope.input.track,
    workspace: scope.input.workspace,
  });
  const accepted =
    status.ok && (status.data.artifacts.find((one) => one.artifact === "hero")?.approved ?? false);

  scope.heroes.set(characterId, accepted);

  return accepted;
}

function heroPath(scope: Scope, characterId: string): Result<string> {
  const character = characterPaths(scope.paths.project, characterId);

  return character.ok ? ok(characterTrackPaths(character.data, scope.input.track).hero) : character;
}

/** What a reference's stage record says about the bytes on disk right now. */
function referenceState(scope: Scope, id: string, sha256: string | null): Attachment["state"] {
  if (sha256 === null) {
    return "absent";
  }

  const record = scope.stage?.artifacts[id];

  if (record === undefined || record.status !== "completed") {
    return "pending";
  }

  if (record.outputs[0]?.sha256 !== sha256) {
    return "changed";
  }

  return record.review.status === "approved" ? "approved" : "pending";
}

/** One identifier, turned into the file this track will attach for it. */
async function resolveAttachment(scope: Scope, id: string): Promise<Result<Attachment>> {
  const reference = scope.manifest.references.find((one) => one.id === id);
  const characterId = id.startsWith(HERO) ? id.slice(HERO.length) : null;
  const path = characterId === null ? referenceOf(scope, id) : heroPath(scope, characterId);

  if (!path.ok) {
    return path;
  }

  const digest = await digestOf(scope, path.data);
  const sha256 = digest?.sha256 ?? null;
  const relative = toWorkspacePath(scope.input.workspace.root, path.data);

  if (characterId !== null) {
    const name = scope.cast.find((member) => member.id === characterId)?.name ?? characterId;
    const accepted = await heroAccepted(scope, characterId);

    return ok({
      bytes: digest?.bytes ?? null,
      id,
      path: relative,
      role: `the canonical image of ${name}; binding for that character's identity`,
      sha256,
      state: digest === null ? "absent" : (accepted && "approved") || "pending",
    });
  }

  if (reference === undefined) {
    return err(new SendPlanError(`pakiet nie zna referencji "${id}"`));
  }

  return ok({
    bytes: digest?.bytes ?? null,
    id,
    path: relative,
    role: `${reference.kind} reference: ${reference.subject}`,
    sha256,
    state: referenceState(scope, id, sha256),
  });
}

function referenceOf(scope: Scope, id: string): Result<string> {
  return referenceImage(scope.paths.trackPaths, id);
}

/** Why one attachment cannot be carried yet, in the words a person reads. */
function attachmentBlocker(scope: Scope, attachment: Attachment): string | null {
  if (attachment.state === "approved") {
    return null;
  }

  const where = `${attachment.id} (${attachment.path})`;

  if (attachment.id.startsWith(HERO)) {
    const characterId = attachment.id.slice(HERO.length);

    return `${where}: obraz postaci nie jest zatwierdzony na torze ${scope.input.track} — aimator check ${scope.input.projectId} ${characterId} --stage character --track ${scope.input.track}`;
  }

  if (attachment.state === "absent") {
    return `${where}: jeszcze nie powstał na torze ${scope.input.track}`;
  }

  return attachment.state === "changed"
    ? `${where}: bajty nie zgadzają się z zapisanym hashem — plik zmieniono poza narzędziem`
    : `${where}: powstał, ale nikt go jeszcze nie przyjął — oceń go i zatwierdź`;
}

interface Artifact {
  readonly direction: string;
  readonly id: string;
  readonly kind: TargetKind;
  readonly name: string;
  readonly referenceIds: readonly string[];
  /** Verbatim shot-list entries, or empty for a reference, which is in no shot. */
  readonly shots: readonly string[];
}

/** The clip's own entry plus every shot it declares, as the document wrote them. */
function clipEntries(scope: Scope, clipId: string): readonly string[] {
  const clip = scope.shotList.clips.find((one) => one.id === clipId);
  const shots = scope.shotList.shots.filter((shot) => shot.clip === clipId);

  return clip === undefined ? [] : [clip.text, ...shots.map((shot) => shot.text)];
}

/**
 * Every artifact the package plans, in production order: the references first
 * because stage 5 draws them, then the opening frame, then each clip preceded
 * by the entry frame it starts from.
 */
function enumerate(scope: Scope): readonly Artifact[] {
  const references = scope.manifest.references.map((one) => ({
    direction: "",
    id: one.id,
    kind: "reference" as const,
    name: one.id,
    referenceIds: one.dependsOn,
    shots: [] as readonly string[],
  }));
  const [firstClip] = scope.manifest.clips;
  const opening = {
    direction: "",
    id: OPENING,
    kind: "opening" as const,
    name: OPENING,
    referenceIds: scope.manifest.opening.referenceIds,
    shots: firstClip === undefined ? [] : clipEntries(scope, firstClip.id),
  };
  const clips = scope.manifest.clips.flatMap((clip, index) => {
    const shots = clipEntries(scope, clip.id);
    const body = {
      direction: "",
      id: clip.id,
      kind: "clip" as const,
      name: clip.id,
      referenceIds: clip.referenceIds,
      shots,
    };

    // The first clip's entry frame is the opening frame, so it has none of its
    // own. Every later one inherits its clip's references: the manifest gives
    // an entry frame no list, because it is that clip's first instant.
    return index === 0
      ? [body]
      : [
          {
            direction: "",
            id: clip.id,
            kind: "entry-frame" as const,
            name: `${ENTRY}${clip.id}`,
            referenceIds: clip.referenceIds,
            shots,
          },
          body,
        ];
  });

  return [...references, opening, ...clips];
}

/** Where the published direction for one artifact lives. */
function directionPath(scope: Scope, artifact: Artifact): Result<string> {
  const paths = promptPaths(scope.paths.episode);

  if (artifact.kind === "opening") {
    return ok(paths.openingFrame);
  }

  // The three numbered kinds share their word with the directory they live in,
  // so the only translation needed is the opening frame's, handled above.
  const kind: PromptKind = artifact.kind;

  return promptFile(paths, kind, artifact.id);
}

async function planOne(
  scope: Scope,
  artifact: Artifact,
  compose: boolean
): Promise<Result<PlannedArtifact>> {
  const path = directionPath(scope, artifact);

  if (!path.ok) {
    return path;
  }

  const attachments: Attachment[] = [];

  for (const id of artifact.referenceIds) {
    // biome-ignore lint/performance/noAwaitInLoops: ordered, and the order is the request
    const resolved = await resolveAttachment(scope, id);

    if (!resolved.ok) {
      return resolved;
    }

    attachments.push(resolved.data);
  }

  const direction = await digestOf(scope, path.data);
  const relative = toWorkspacePath(scope.input.workspace.root, path.data);
  const blockers = attachments
    .map((attachment) => attachmentBlocker(scope, attachment))
    .filter((problem): problem is string => problem !== null);

  if (direction === null) {
    blockers.push(`brakuje ${relative} — etap 4 nie opublikował promptu dla ${artifact.name}`);
  }

  if (attachments.length > scope.limit) {
    blockers.push(
      `${artifact.name}: ${attachments.length} referencji, a tor ${scope.input.track} przyjmuje najwyżej ${scope.limit} — zaplanuj ich mniej w pakiecie zamiast liczyć na to, że narzędzie wybierze za ciebie`
    );
  }

  const shotListInput =
    artifact.shots.length === 0 ? [] : await recordFile(scope, scope.paths.episode.shotList);

  return ok({
    attachments,
    blockers,
    id: artifact.id,
    inputs: [
      ...scope.shared,
      ...shotListInput,
      ...(direction === null ? [] : [{ path: relative, sha256: direction.sha256 }]),
      ...attachments
        .filter((attachment) => attachment.sha256 !== null)
        .map((attachment) => ({ path: attachment.path, sha256: attachment.sha256 as string })),
    ],
    kind: artifact.kind,
    name: artifact.name,
    text:
      compose && direction !== null
        ? composePrompt({
            aspectRatio: scope.aspectRatio,
            direction: direction.bytes.toString("utf8"),
            rules: scope.rules,
            shots: artifact.shots,
            size: scope.size,
            slots: attachments.map(
              (attachment): AttachmentSlot => ({ id: attachment.id, role: attachment.role })
            ),
          })
        : null,
  });
}

async function recordFile(scope: Scope, path: string): Promise<readonly RecordedFile[]> {
  const digest = await digestOf(scope, path);

  return digest === null
    ? []
    : [{ path: toWorkspacePath(scope.input.workspace.root, path), sha256: digest.sha256 }];
}

/**
 * What every image stage from 5 on would send for this episode, on one track.
 *
 * It answers for every planned artifact at once, and composes in full only the
 * ones that were named. A summary costs a handful of digests; composing all
 * twenty-odd would quote `project.md` twenty-odd times at somebody who asked
 * what there was to draw.
 */
export async function readSendPlan(input: SendPlanInput): Promise<Result<SendPlan>> {
  const paths = resolvePaths(input);

  if (!paths.ok) {
    return paths;
  }

  const stage0 = await readStage0Inputs(input);

  if (!stage0.ok) {
    return stage0;
  }

  const frame = frameSize(stage0.data.aspectRatio);

  if (!frame.ok) {
    return frame;
  }

  const plan = await checkShotList(input);

  if (!plan.ok) {
    return plan;
  }

  if (plan.data.verdict === null) {
    return err(
      new SendPlanError(
        `odcinek "${input.episodeId}": lista ujęć nie jest gotowa, więc nie ma czego dołączyć do promptu`,
        plan.data.problems
      )
    );
  }

  const status = await checkPromptPackage(input);

  if (!status.ok) {
    return status;
  }

  if (status.data.verdict === null) {
    return err(
      new SendPlanError(
        `odcinek "${input.episodeId}": pakiet promptów nie jest gotowy — etapy obrazowe nie mają planu`,
        status.data.problems
      )
    );
  }

  const stage = await readJson(paths.data.trackPaths.referencesStage, stageFileSchema);
  const scope: Scope = {
    aspectRatio: stage0.data.aspectRatio,
    cast: stage0.data.cast,
    digests: new Map(),
    heroes: new Map(),
    input,
    limit: referenceLimit(input.track),
    manifest: status.data.verdict,
    paths: paths.data,
    rules: stage0.data.rules,
    shared: [],
    shotList: plan.data.verdict,
    size: frame.data,
    stage: stage.ok ? stage.data : null,
  };
  const shared = [
    ...(await recordFile(scope, paths.data.project.file)),
    ...(await recordFile(scope, paths.data.project.rules)),
    ...(await recordFile(scope, paths.data.episode.promptPackage)),
  ];
  const withShared: Scope = { ...scope, shared };
  const planned = enumerate(withShared);
  const known = new Set(planned.map((artifact) => artifact.name));
  const unknown = input.targets.filter((name) => !known.has(name));

  if (unknown.length > 0) {
    return err(
      new SendPlanError(
        `--artifact "${unknown.join(", ")}" — ten pakiet planuje: ${[...known].join(", ")}`
      )
    );
  }

  const wanted = new Set(input.targets);
  const artifacts: PlannedArtifact[] = [];

  for (const artifact of planned) {
    // biome-ignore lint/performance/noAwaitInLoops: one artifact at a time, in order
    const one = await planOne(withShared, artifact, wanted.has(artifact.name));

    if (!one.ok) {
      return one;
    }

    artifacts.push(one.data);
  }

  return ok({
    artifacts,
    aspectRatio: stage0.data.aspectRatio,
    limit: withShared.limit,
    problems: status.data.approved
      ? []
      : [
          ...status.data.problems,
          `etap 4 musi mieć review.status = "approved" zanim którykolwiek etap obrazowy wyda pieniądze: aimator approve ${input.projectId} ${input.episodeId} --stage prompt-package`,
        ],
    promptVersion: PROMPT_VERSION,
    size: frame.data,
    track: input.track,
  });
}
