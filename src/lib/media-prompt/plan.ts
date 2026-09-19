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
  clipFrame,
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
  workspacePath,
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
/**
 * The frame a clip ends on. Stage 4 never writes this id — it has no word for a
 * frame that does not exist until a clip has been rendered and accepted — so it
 * is minted here, by the sender, and printed in the attachment list like any
 * other. Rule 8 binds the planning stage to ids the sender will list; it does
 * not stop the sender from carrying one the planner could not have known.
 */
const END = "end:";

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
  /**
   * How many seconds a clip runs, straight from the approved shot list, or
   * `null` for anything that is a single instant. It travels with the plan
   * because it is both what the request orders and what the verdict compares
   * the answer against.
   */
  readonly seconds: number | null;
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
  /**
   * This track's own results, per stage that writes any: stage 5's references,
   * stage 6's opening frame and stage 7's clips and entry frames. `null` means
   * that stage has drawn nothing here yet.
   *
   * Three files rather than one because rule 1 gives each stage its own, and
   * this module is the one place that has to read all of them: whether an
   * attachment may be carried is the same question whichever stage produced it.
   */
  readonly stages: {
    readonly clips: StageFile | null;
    readonly openingFrame: StageFile | null;
    readonly references: StageFile | null;
  };
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

/**
 * What a stage record says about the bytes on disk right now.
 *
 * The output is matched by path rather than by position, because a record can
 * own more than one file: a clip's record holds the video and the frame it
 * ended on, and only one of those is ever an attachment.
 */
function stateOf(
  record: StageFile["artifacts"][string] | undefined,
  relative: string,
  sha256: string | null
): Attachment["state"] {
  if (sha256 === null) {
    return "absent";
  }

  if (record === undefined || record.status !== "completed") {
    return "pending";
  }

  const output = record.outputs.find((one) => one.path === relative);

  if (output === undefined) {
    return "pending";
  }

  if (output.sha256 !== sha256) {
    return "changed";
  }

  return record.review.status === "approved" ? "approved" : "pending";
}

/**
 * The frame a clip ended on, read from that clip's own record.
 *
 * Asked of the record rather than built from a name, because the still is
 * published in whatever format the video provider handed back — a JPEG, in
 * practice — and the record is the one place that says which file it actually
 * is. A path guessed from an extension would report a frame that exists as
 * missing, which is the worst kind of gate: one that blocks over a spelling.
 *
 * Its acceptance is the clip's: the frame is that clip's last instant, bought
 * and reviewed in the same breath.
 */
function endFrameOf(
  scope: Scope,
  clipId: string
): { record: StageFile["artifacts"][string] | undefined; path: string; role: string } {
  const record = scope.stages.clips?.artifacts[clipId];
  const recorded = record?.outputs.find((one) => one.path.includes(`/frames/${clipId}/end.`));
  // With no record there is no file yet, and the name the clip *would* write is
  // the honest thing to report as missing.
  const wouldWrite = clipFrame(scope.paths.trackPaths, clipId, "end");
  const absent = wouldWrite.ok ? wouldWrite.data : scope.paths.trackPaths.frames;

  return {
    path: recorded === undefined ? absent : workspacePath(scope.input.workspace, recorded.path),
    record,
    role: `the accepted final frame of ${clipId} — reproduce this instant exactly, advancing nothing`,
  };
}

/** Which file an identifier names on this track, and what states its acceptance. */
function locate(
  scope: Scope,
  id: string
): Result<{ record: StageFile["artifacts"][string] | undefined; path: string; role: string }> {
  const paths = scope.paths.trackPaths;

  if (id === OPENING) {
    return ok({
      path: paths.openingFrameImage,
      record: scope.stages.openingFrame?.artifacts[OPENING],
      role: "the accepted opening frame of this episode — the exact instant this clip starts on",
    });
  }

  if (id.startsWith(ENTRY)) {
    const clipId = id.slice(ENTRY.length);
    const file = clipFrame(paths, clipId, "entry");

    return file.ok
      ? ok({
          path: file.data,
          record: scope.stages.clips?.artifacts[id],
          role: `the accepted entry frame of ${clipId} — the exact instant this clip starts on`,
        })
      : file;
  }

  if (id.startsWith(END)) {
    return ok(endFrameOf(scope, id.slice(END.length)));
  }

  const reference = scope.manifest.references.find((one) => one.id === id);

  if (reference === undefined) {
    return err(new SendPlanError(`pakiet nie zna referencji "${id}"`));
  }

  const file = referenceImage(paths, id);

  return file.ok
    ? ok({
        path: file.data,
        record: scope.stages.references?.artifacts[id],
        role: `${reference.kind} reference: ${reference.subject}`,
      })
    : file;
}

/** One identifier, turned into the file this track will attach for it. */
async function resolveAttachment(scope: Scope, id: string): Promise<Result<Attachment>> {
  const characterId = id.startsWith(HERO) ? id.slice(HERO.length) : null;

  if (characterId !== null) {
    return await resolveHero(scope, id, characterId);
  }

  const located = locate(scope, id);

  if (!located.ok) {
    return located;
  }

  const digest = await digestOf(scope, located.data.path);
  const sha256 = digest?.sha256 ?? null;
  const relative = toWorkspacePath(scope.input.workspace.root, located.data.path);

  return ok({
    bytes: digest?.bytes ?? null,
    id,
    path: relative,
    role: located.data.role,
    sha256,
    state: stateOf(located.data.record, relative, sha256),
  });
}

async function resolveHero(
  scope: Scope,
  id: string,
  characterId: string
): Promise<Result<Attachment>> {
  const path = heroPath(scope, characterId);

  if (!path.ok) {
    return path;
  }

  const digest = await digestOf(scope, path.data);
  const name = scope.cast.find((member) => member.id === characterId)?.name ?? characterId;
  const accepted = await heroAccepted(scope, characterId);

  return ok({
    bytes: digest?.bytes ?? null,
    id,
    path: toWorkspacePath(scope.input.workspace.root, path.data),
    role: `the canonical image of ${name}; binding for that character's identity`,
    sha256: digest?.sha256 ?? null,
    state: digest === null ? "absent" : (accepted && "approved") || "pending",
  });
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
    return `${where}: ${missing(attachment.id, scope.input.track)}`;
  }

  return attachment.state === "changed"
    ? `${where}: bajty nie zgadzają się z zapisanym hashem — plik zmieniono poza narzędziem`
    : `${where}: powstał, ale nikt go jeszcze nie przyjął — oceń go i zatwierdź`;
}

/** What is missing, in the words of the stage that has to produce it. */
function missing(id: string, track: ImageTrack): string {
  if (id === OPENING) {
    return `klatka otwarcia nie powstała na torze ${track} — to etap 6`;
  }

  if (id.startsWith(ENTRY)) {
    return `klatka wejściowa ${id.slice(ENTRY.length)} nie powstała na torze ${track}`;
  }

  return id.startsWith(END)
    ? `końcówka klipu ${id.slice(END.length)} jeszcze nie istnieje na torze ${track} — powstaje razem z tym klipem`
    : `jeszcze nie powstał na torze ${track}`;
}

interface Artifact {
  readonly direction: string;
  readonly id: string;
  readonly kind: TargetKind;
  readonly name: string;
  readonly referenceIds: readonly string[];
  /** How long a clip runs. `null` for everything that is one instant. */
  readonly seconds: number | null;
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
    seconds: null,
    shots: [] as readonly string[],
  }));
  const [firstClip] = scope.manifest.clips;
  const opening = {
    direction: "",
    id: OPENING,
    kind: "opening" as const,
    name: OPENING,
    referenceIds: scope.manifest.opening.referenceIds,
    seconds: null,
    shots: firstClip === undefined ? [] : clipEntries(scope, firstClip.id),
  };
  const clips = scope.manifest.clips.flatMap((clip, index) => {
    const shots = clipEntries(scope, clip.id);
    const previous = scope.manifest.clips[index - 1];
    const planned = scope.shotList.clips.find((one) => one.id === clip.id);
    const body = {
      direction: "",
      id: clip.id,
      kind: "clip" as const,
      name: clip.id,
      // A video request carries the frame it starts on and nothing else: the
      // provider treats a pinned first frame and reference images as mutually
      // exclusive modes. The clip's own reference list is not lost — it is what
      // the entry frame below was drawn from, which is where those images do
      // their work.
      referenceIds: [index === 0 ? OPENING : `${ENTRY}${clip.id}`],
      seconds: planned === undefined ? null : planned.end - planned.start,
      shots,
    };

    // The first clip's entry frame is the opening frame, so it has none of its
    // own. Every later one inherits its clip's references: the manifest gives
    // an entry frame no list, because it is that clip's first instant.
    if (index === 0) {
      return [body];
    }

    // What the shot list says this clip is seeded from decides what its entry
    // frame is drawn from — not whether it is drawn. A clip that continues the
    // action starts from the accepted end of the one before it, so that frame
    // leads the attachment list and the direction says to advance nothing; a
    // clip that opens a new scene continues nothing and carries only its own
    // references.
    const continues =
      previous !== undefined && planned?.reference === "previous-end-frame"
        ? [`${END}${previous.id}`]
        : [];

    return [
      {
        direction: "",
        id: clip.id,
        kind: "entry-frame" as const,
        name: `${ENTRY}${clip.id}`,
        referenceIds: [...continues, ...clip.referenceIds],
        seconds: null,
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

  // The limit is an image track's: how many references one drawing request
  // carries. A clip carries exactly one attachment by construction, so there is
  // nothing here for that limit to be about.
  if (artifact.kind !== "clip" && attachments.length > scope.limit) {
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
    seconds: artifact.seconds,
    text:
      compose && direction !== null
        ? composePrompt({
            aspectRatio: scope.aspectRatio,
            direction: direction.bytes.toString("utf8"),
            output:
              artifact.kind === "clip" && artifact.seconds !== null
                ? { kind: "video", seconds: artifact.seconds }
                : { kind: "image" },
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

  const references = await readJson(paths.data.trackPaths.referencesStage, stageFileSchema);
  const openingFrame = await readJson(paths.data.trackPaths.openingFrameStage, stageFileSchema);
  const clips = await readJson(paths.data.trackPaths.clipsStage, stageFileSchema);
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
    stages: {
      clips: clips.ok ? clips.data : null,
      openingFrame: openingFrame.ok ? openingFrame.data : null,
      references: references.ok ? references.data : null,
    },
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
