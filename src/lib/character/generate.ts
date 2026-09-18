import {
  applyWrites,
  emptyStage,
  modelProducer,
  newRecord,
  newRunId,
  nowIso,
  type RecordedFile,
  readDigest,
  readJson,
  removeFile,
  type StageFile,
  serialize,
  sha256Of,
  stageFileSchema,
  toWorkspacePath,
  type WriteMode,
  writeNew,
  writeNewBytes,
} from "../artifact/index.js";
import { readStage0Character, type Stage0Character } from "../project/index.js";
import { err, ok, type Result } from "../result.js";
import {
  type CharacterTrackPaths,
  characterPaths,
  characterTrackPaths,
  characterViewImage,
  type ImageRunPaths,
  type ImageTrack,
  imageRunPaths,
  projectPaths,
  type Workspace,
} from "../workspace.js";
import {
  archiveRequest,
  attach,
  buildRequest,
  callImage,
  downloadImage,
  type ImageAttachment,
  type ImageRequest,
  sizeOf,
} from "./client.js";
import {
  buildPrompt,
  CHARACTER_ARTIFACTS,
  CHARACTER_VIEWS,
  type CharacterArtifact,
  PROMPT_VERSION,
  type ReferenceSlot,
  referencePlan,
} from "./prompt.js";
import { type ImageVerdict, readImageResponse, validateImage } from "./validate.js";

/**
 * Internal to the character module: the command that spends money.
 *
 * The order of operations is the contract, and it is stage 1's order applied
 * ten times over. Nothing is written in `--dry-run`. In a real run each
 * artifact records `submitted` *before* its own POST, so an interrupted attempt
 * leaves a trace saying a charge may have happened for that one image rather
 * than looking like it never ran. Nothing retries on its own.
 *
 * What stage 1 could not do and this can: resume without paying again. gpt-image
 * returns the bytes inline, so a saved response body is the image; seedream
 * returns a URL good for 24 hours, so a saved body is a second unbilled chance
 * to fetch it. An attempt that died after the POST is therefore usually
 * recoverable here, and `--regenerate` stays the last resort rather than the
 * only way forward.
 */

export interface ArtifactOutcome {
  readonly artifact: CharacterArtifact;
  readonly note: string;
  /** `--dry-run` only: the exact text a paid call would send. */
  readonly prompt: string | null;
  readonly references: readonly RecordedFile[];
  readonly runId: string | null;
  readonly state: "blocked" | "planned" | "published" | "resumed" | "skipped";
  readonly verdict: ImageVerdict | null;
}

export interface CharacterReport {
  /** Whether stage 0 is approved for this project. */
  readonly approved: boolean;
  readonly artifacts: readonly ArtifactOutcome[];
  readonly created: readonly string[];
  readonly name: string;
  readonly nextStep: string;
  readonly problems: readonly string[];
  readonly ready: boolean;
  readonly track: ImageTrack;
}

interface GenerateCharacterInput {
  readonly apiKey: string | null;
  /** Narrows the run; empty means "whatever the gates allow next". */
  readonly artifacts: readonly CharacterArtifact[];
  readonly characterId: string;
  readonly fetch: typeof fetch;
  readonly mode: WriteMode;
  readonly model: string | null;
  readonly projectId: string;
  readonly regenerate: boolean;
  readonly track: ImageTrack;
  readonly workspace: Workspace;
}

const STAGE = "character";

class Stage2BlockedError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `etap 2 nie może wykonać płatnego wywołania:\n${problems.map((p) => `  - ${p}`).join("\n")}`
    );
    this.name = "Stage2BlockedError";
    this.problems = problems;
  }
}

class LockError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(
      `inna próba trzyma blokadę ${path} — po awarii upewnij się, że poprzedni proces nie działa, zanim usuniesz ten plik`
    );
    this.name = "LockError";
    this.path = path;
  }
}

/** The secret's env var, named per track so an error can say which one is missing. */
const KEY_NAME: Record<ImageTrack, string> = {
  "gpt-image": "OPENAI_API_KEY",
  seedream: "BYTEPLUS_MODELARK",
};

const MODEL_NAME: Record<ImageTrack, string> = {
  "gpt-image": "AIMATOR_IMAGE_MODEL_GPT_IMAGE",
  seedream: "AIMATOR_IMAGE_MODEL_SEEDREAM",
};

interface Scope {
  readonly paths: CharacterTrackPaths;
  readonly stage: StageFile;
  readonly stage0: Stage0Character;
}

function write(path: string, text: string): Promise<Result<readonly string[]>> {
  return applyWrites([{ kind: "text", text, to: path }], "apply");
}

function writeImage(path: string, bytes: Buffer): Promise<Result<readonly string[]>> {
  return applyWrites([{ bytes, kind: "bytes", to: path }], "apply");
}

/**
 * Why a paid call may not happen at all. Empty means it may.
 *
 * A dry run never reads the key, so it must not claim the key is missing — it
 * says what it did not check instead. Claiming to have found an absence you
 * never looked for is the same lie as claiming a success you never had.
 */
function blockers(input: GenerateCharacterInput, stage0: Stage0Character): readonly string[] {
  const problems = [...(stage0.approved ? [] : stage0.problems)];

  if (!stage0.approved) {
    problems.push(
      `etap 0 musi mieć review.status = "approved" zanim etap 2 wyda pieniądze: aimator approve ${input.projectId}`
    );
  }

  if (input.model === null || input.model === "") {
    problems.push(
      `brak modelu obrazowego dla toru ${input.track} — wskaż go przez --model <id> albo ${MODEL_NAME[input.track]}`
    );
  }

  if (input.mode !== "dry-run" && (input.apiKey === null || input.apiKey === "")) {
    problems.push(`brak ${KEY_NAME[input.track]} w środowisku lub .env`);
  }

  return problems;
}

/** A record that finished and whose bytes a human has accepted. */
function accepted(stage: StageFile, key: CharacterArtifact): boolean {
  const record = stage.artifacts[key];

  return record?.status === "completed" && record.review.status === "approved";
}

/**
 * Why one artifact may not be drawn yet. Empty means it may.
 *
 * This is the sequence the whole stage exists to enforce: the views are drawn
 * from the card, so they wait for a human to accept the card; the hero is drawn
 * from the views, so it waits for all eight. Validation never opens either gate
 * — only an explicit approval does.
 */
function sequenceGate(stage: StageFile, artifact: CharacterArtifact): readonly string[] {
  if (artifact === "card") {
    return [];
  }

  if (artifact === "hero") {
    const missing = CHARACTER_VIEWS.filter((view) => !accepted(stage, view));

    return missing.length === 0
      ? []
      : [`hero czeka na zatwierdzenie widoków: ${missing.join(", ")}`];
  }

  return accepted(stage, "card")
    ? []
    : ["widoki czekają na zatwierdzenie karty — oceń card.png i zatwierdź ją"];
}

/**
 * What this invocation is about, when the user named nothing.
 *
 * The gates make the answer single-valued: exactly one step of the sequence is
 * ever runnable, so `character generate` with no flags does the next thing and
 * stops, rather than trying to spend the whole stage's budget in one go.
 */
function nextGroup(stage: StageFile): readonly CharacterArtifact[] {
  if (stage.artifacts.card?.status !== "completed") {
    return ["card"];
  }

  if (!accepted(stage, "card")) {
    return [];
  }

  const pending = CHARACTER_VIEWS.filter((view) => stage.artifacts[view]?.status !== "completed");

  if (pending.length > 0) {
    return pending;
  }

  const unapproved = CHARACTER_VIEWS.filter((view) => !accepted(stage, view));

  if (unapproved.length > 0) {
    return [];
  }

  return stage.artifacts.hero?.status === "completed" ? [] : ["hero"];
}

async function readStage(path: string): Promise<StageFile> {
  const stage = await readJson(path, stageFileSchema);

  return stage.ok ? stage.data : emptyStage(STAGE);
}

function withRecord(
  stage: StageFile,
  key: CharacterArtifact,
  record: StageFile["artifacts"][string]
): StageFile {
  return { ...stage, artifacts: { ...stage.artifacts, [key]: record } };
}

export async function generateCharacter(
  input: GenerateCharacterInput
): Promise<Result<CharacterReport>> {
  const project = projectPaths(input.workspace, input.projectId);

  if (!project.ok) {
    return project;
  }

  const character = characterPaths(project.data, input.characterId);

  if (!character.ok) {
    return character;
  }

  const stage0 = await readStage0Character(input);

  if (!stage0.ok) {
    return stage0;
  }

  const paths = characterTrackPaths(character.data, input.track);
  const stage = await readStage(paths.stage);

  // A new charge names its target. Without a flag the gates decide what runs
  // next, and what runs next is never something already finished — so a bare
  // `--regenerate` would silently do nothing or, worse, hit the wrong image.
  if (input.regenerate && input.artifacts.length === 0) {
    return err(
      new Stage2BlockedError([
        `--regenerate wymaga jawnego celu: --artifact ${CHARACTER_ARTIFACTS.join("|")}`,
        "nowa płatna próba zawsze dotyczy konkretnego obrazu",
      ])
    );
  }

  const problems = blockers(input, stage0.data);
  const targets = input.artifacts.length > 0 ? input.artifacts : nextGroup(stage);
  const scope: Scope = { paths, stage, stage0: stage0.data };

  if (input.mode === "dry-run") {
    return await preview(input, scope, targets, problems);
  }

  if (problems.length > 0) {
    return err(new Stage2BlockedError(problems));
  }

  if (targets.length === 0) {
    return ok(idle(input, scope));
  }

  const lock = await writeNew(paths.lock, serialize({ pid: process.pid, startedAt: nowIso() }));

  if (!lock.ok) {
    return err(new LockError(paths.lock));
  }

  try {
    return await runAll(input, scope, targets);
  } finally {
    await removeFile(paths.lock);
  }
}

/** Nothing to do: every runnable step is done and the rest waits on a human. */
function idle(input: GenerateCharacterInput, scope: Scope): CharacterReport {
  const waiting = CHARACTER_ARTIFACTS.filter(
    (artifact) =>
      scope.stage.artifacts[artifact]?.status === "completed" && !accepted(scope.stage, artifact)
  );

  return {
    approved: scope.stage0.approved,
    artifacts: [],
    created: [],
    name: scope.stage0.name,
    nextStep:
      waiting.length > 0
        ? `oceń i zatwierdź: aimator approve ${input.projectId} ${input.characterId} --stage character --track ${input.track} --artifact ${waiting.join(",")}`
        : `etap 2 dla "${input.characterId}" na torze ${input.track} jest kompletny`,
    problems: waiting.length > 0 ? [`czekają na ocenę człowieka: ${waiting.join(", ")}`] : [],
    ready: waiting.length === 0,
    track: input.track,
  };
}

/**
 * `--dry-run`: the full plan, with no network, no secret and no write.
 *
 * It shows every prompt in full, because the point of a preview on a stage this
 * expensive is to let a person read what would be sent before it is.
 */
async function preview(
  input: GenerateCharacterInput,
  scope: Scope,
  targets: readonly CharacterArtifact[],
  problems: readonly string[]
): Promise<Result<CharacterReport>> {
  const outcomes: ArtifactOutcome[] = [];

  for (const artifact of targets) {
    // biome-ignore lint/performance/noAwaitInLoops: one plan at a time, in order
    const planned = await planOne(input, scope, artifact);

    if (!planned.ok) {
      return planned;
    }

    outcomes.push(planned.data);
  }

  const gated = outcomes.filter((outcome) => outcome.state === "blocked");

  return ok({
    approved: scope.stage0.approved,
    artifacts: outcomes,
    created: [],
    name: scope.stage0.name,
    nextStep:
      problems.length === 0 && gated.length === 0
        ? `aimator character generate ${input.projectId} ${input.characterId} --track ${input.track}`
        : "usuń powyższe przeszkody przed płatnym wywołaniem",
    problems: [
      ...problems,
      `${KEY_NAME[input.track]} nie był czytany — próba na sucho nie sięga po sekrety; płatne wywołanie go wymaga`,
    ],
    ready: problems.length === 0 && gated.length === 0,
    track: input.track,
  });
}

interface Plan {
  readonly attachments: readonly ImageAttachment[];
  readonly inputs: readonly RecordedFile[];
  readonly prompt: string;
  readonly references: readonly RecordedFile[];
}

/**
 * What one artifact would be drawn from, and the exact prompt for it.
 *
 * The references are re-read and re-hashed here rather than trusted from the
 * stage file: a card edited outside the tool must not silently become the
 * authority for eight views drawn from it.
 */
async function planOne(
  input: GenerateCharacterInput,
  scope: Scope,
  artifact: CharacterArtifact
): Promise<Result<ArtifactOutcome>> {
  const gate = sequenceGate(scope.stage, artifact);
  const plan = await buildPlan(input, scope, artifact);

  if (!plan.ok) {
    return gate.length > 0
      ? ok({
          artifact,
          note: gate.join("; "),
          prompt: null,
          references: [],
          runId: null,
          state: "blocked",
          verdict: null,
        })
      : plan;
  }

  return ok({
    artifact,
    note: gate.length > 0 ? gate.join("; ") : "gotowe do płatnego wywołania",
    prompt: plan.data.prompt,
    references: plan.data.references,
    runId: null,
    state: gate.length > 0 ? "blocked" : "planned",
    verdict: null,
  });
}

async function buildPlan(
  input: GenerateCharacterInput,
  scope: Scope,
  artifact: CharacterArtifact
): Promise<Result<Plan>> {
  const photographs = scope.stage0.sources.map((source) => basenameOf(source.path));
  const slots = referencePlan({
    artifact,
    basis: scope.stage0.basis,
    photographs,
    track: input.track,
  });

  if (!slots.ok) {
    return slots;
  }

  const resolved = await resolveSlots(input, scope, slots.data);

  if (!resolved.ok) {
    return resolved;
  }

  return ok({
    attachments: resolved.data.map((entry) => entry.attachment),
    inputs: [
      ...scope.stage0.inputs,
      ...resolved.data.map((entry) => entry.reference).filter((ref) => !isStage0(scope, ref)),
    ],
    prompt: buildPrompt({
      artifact,
      basis: scope.stage0.basis,
      name: scope.stage0.name,
      references: slots.data,
      rules: scope.stage0.rules,
    }),
    references: resolved.data.map((entry) => entry.reference),
  });
}

function isStage0(scope: Scope, reference: RecordedFile): boolean {
  return scope.stage0.inputs.some((entry) => entry.path === reference.path);
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

interface ResolvedSlot {
  readonly attachment: ImageAttachment;
  readonly reference: RecordedFile;
}

/** Turns the plan's slots into bytes, refusing anything that no longer matches. */
async function resolveSlots(
  input: GenerateCharacterInput,
  scope: Scope,
  slots: readonly ReferenceSlot[]
): Promise<Result<readonly ResolvedSlot[]>> {
  const out: ResolvedSlot[] = [];

  for (const slot of slots) {
    const path = pathOf(scope, slot);

    if (!path.ok) {
      return path;
    }

    // biome-ignore lint/performance/noAwaitInLoops: ordered, and the order is the prompt
    const digest = await readDigest(path.data);

    if (!digest.ok) {
      return err(
        new Stage2BlockedError([
          `brakuje referencji ${slot.name} (${toWorkspacePath(input.workspace.root, path.data)})`,
        ])
      );
    }

    const expected = expectedDigest(scope, slot);

    if (expected !== null && expected !== digest.data.sha256) {
      return err(
        new Stage2BlockedError([
          `${slot.name}: bajty nie zgadzają się z zatwierdzonym hashem — plik zmieniono poza narzędziem, więc nie jest już tym, co ktoś przyjął`,
        ])
      );
    }

    out.push({
      attachment: attach(slot.name, digest.data.bytes),
      reference: {
        path: toWorkspacePath(input.workspace.root, path.data),
        sha256: digest.data.sha256,
      },
    });
  }

  return ok(out);
}

function pathOf(scope: Scope, slot: ReferenceSlot): Result<string> {
  if (slot.kind === "card") {
    return ok(scope.paths.card);
  }

  if (slot.kind === "view") {
    return characterViewImage(scope.paths, slot.name);
  }

  const source = scope.stage0.sources.find((entry) => basenameOf(entry.path) === slot.name);

  return source === undefined
    ? err(new Stage2BlockedError([`nie znaleziono zdjęcia ${slot.name} w materiałach postaci`]))
    : ok(source.path);
}

/** The digest a reference must still have, or `null` when stage 0 already owns it. */
function expectedDigest(scope: Scope, slot: ReferenceSlot): string | null {
  if (slot.kind === "photograph") {
    return (
      scope.stage0.sources.find((entry) => basenameOf(entry.path) === slot.name)?.sha256 ?? null
    );
  }

  const key: CharacterArtifact = slot.kind === "card" ? "card" : (slot.name as CharacterArtifact);

  return scope.stage.artifacts[key]?.outputs[0]?.sha256 ?? null;
}

async function runAll(
  input: GenerateCharacterInput,
  scope: Scope,
  targets: readonly CharacterArtifact[]
): Promise<Result<CharacterReport>> {
  const outcomes: ArtifactOutcome[] = [];
  const created: string[] = [];
  let { stage } = scope;

  for (const artifact of targets) {
    // Sequential on purpose: a view is drawn from the card, and the eight of
    // them are eight separate charges that must stay individually legible.
    // biome-ignore lint/performance/noAwaitInLoops: one paid call at a time
    const outcome = await runOne(input, { ...scope, stage }, artifact);

    if (!outcome.ok) {
      // Whatever already succeeded stays written and reported; the series stops.
      return outcomes.length === 0
        ? outcome
        : err(
            new Stage2BlockedError([
              ...outcomes.map((earlier) => `${earlier.artifact}: ${earlier.note}`),
              `${artifact}: ${outcome.error.message}`,
              "seria zatrzymana; wcześniejsze wyniki zachowane",
            ])
          );
    }

    const done = outcome.data;

    outcomes.push(done.outcome);
    created.push(...done.created);
    ({ stage } = done);
  }

  const drawn = outcomes.filter((outcome) => outcome.state !== "blocked");

  return ok({
    approved: scope.stage0.approved,
    artifacts: outcomes,
    created,
    name: scope.stage0.name,
    nextStep:
      drawn.length > 0
        ? `oceń wyniki, a potem: aimator approve ${input.projectId} ${input.characterId} --stage character --track ${input.track} --artifact ${drawn.map((o) => o.artifact).join(",")}`
        : `usuń przeszkody i powtórz: aimator character generate ${input.projectId} ${input.characterId} --track ${input.track}`,
    problems: outcomes.filter((o) => o.state === "blocked").map((o) => `${o.artifact}: ${o.note}`),
    ready: drawn.length > 0,
    track: input.track,
  });
}

interface OneResult {
  readonly created: readonly string[];
  readonly outcome: ArtifactOutcome;
  readonly stage: StageFile;
}

async function runOne(
  input: GenerateCharacterInput,
  scope: Scope,
  artifact: CharacterArtifact
): Promise<Result<OneResult>> {
  const gate = sequenceGate(scope.stage, artifact);

  if (gate.length > 0) {
    return ok({
      created: [],
      outcome: {
        artifact,
        note: gate.join("; "),
        prompt: null,
        references: [],
        runId: null,
        state: "blocked",
        verdict: null,
      },
      stage: scope.stage,
    });
  }

  const record = scope.stage.artifacts[artifact];

  if (record !== undefined && !input.regenerate) {
    if (record.status === "completed") {
      return ok({
        created: [],
        outcome: {
          artifact,
          note: "wynik już istnieje; nową płatną próbę zaczyna wyłącznie --regenerate",
          prompt: null,
          references: [],
          runId: record.runId,
          state: "skipped",
          verdict: null,
        },
        stage: scope.stage,
      });
    }

    return await resume(input, scope, artifact, record);
  }

  return await attempt(input, scope, artifact);
}

/**
 * Finishes an attempt that already reached the provider, without paying again.
 *
 * A `submitted` record whose archive holds the response is an image that is
 * bought and paid for. gpt-image put the bytes in that body; seedream put a URL
 * that lives 24 hours. Re-deriving the result from either must cost nothing,
 * because otherwise a bug in the validator would be billable. Nothing is
 * re-posted here.
 */
async function resume(
  input: GenerateCharacterInput,
  scope: Scope,
  artifact: CharacterArtifact,
  record: StageFile["artifacts"][string]
): Promise<Result<OneResult>> {
  const run = imageRunPaths(scope.paths, record.runId);
  const saved = await readDigest(run.response);

  if (!saved.ok) {
    return err(
      new Stage2BlockedError([
        `próba ${record.runId} zapisała status "submitted", ale nie ma zapisanej odpowiedzi — mogła zostać rozliczona`,
        "nie ma czego wznowić; nową płatną próbę zaczyna wyłącznie --regenerate",
      ])
    );
  }

  const changed = record.inputs.filter(
    (entry) =>
      !scope.stage0.inputs.some((now) => now.path === entry.path && now.sha256 === entry.sha256)
  );

  if (changed.length > 0) {
    return err(
      new Stage2BlockedError([
        ...changed.map((entry) => `${entry.path}: zmienił się od czasu próby ${record.runId}`),
        "zapisana odpowiedź opisuje inne wejście — nową płatną próbę zaczyna --regenerate",
      ])
    );
  }

  const bytes = await imageBytes(input, run, saved.data.bytes.toString("utf8"));

  if (!bytes.ok) {
    return bytes;
  }

  return await publish(input, scope, artifact, {
    bytes: bytes.data.bytes,
    inputs: record.inputs,
    jobId: bytes.data.jobId,
    producer: record.producer,
    references: [],
    resumed: true,
    run,
    runId: record.runId,
  });
}

async function attempt(
  input: GenerateCharacterInput,
  scope: Scope,
  artifact: CharacterArtifact
): Promise<Result<OneResult>> {
  const plan = await buildPlan(input, scope, artifact);

  if (!plan.ok) {
    return plan;
  }

  const runId = newRunId();
  const run = imageRunPaths(scope.paths, runId);
  const model = input.model ?? "";
  const request = buildRequest({
    artifact,
    attachments: plan.data.attachments,
    model,
    prompt: plan.data.prompt,
    track: input.track,
  });
  const producer = modelProducer({
    endpoint: request.endpoint,
    model,
    promptVersion: PROMPT_VERSION,
  });
  const prepared = await prepare(run, {
    artifact,
    inputs: plan.data.inputs,
    request,
    runId,
  });

  if (!prepared.ok) {
    return prepared;
  }

  const previous = await previousImage(input, scope, artifact);

  if (previous !== null) {
    await writeNewBytes(run.previousImage, previous);
  }

  // Submitted lands on disk before the POST. An attempt that dies mid-call is
  // then visibly an attempt that may already have been billed — for this one
  // image, not for the whole series.
  const submitted = withRecord(
    scope.stage,
    artifact,
    newRecord({
      inputs: plan.data.inputs,
      outputs: [],
      producer,
      runId,
      status: "submitted",
    })
  );

  await write(scope.paths.stage, serialize(submitted));

  const transport = await callImage({
    apiKey: input.apiKey ?? "",
    fetch: input.fetch,
    request,
  });

  if (transport.ok) {
    await writeNew(run.transport, serialize(transport.data));
    await writeNew(run.response, transport.data.body);
  }

  if (!transport.ok) {
    return transport;
  }

  const bytes = await imageBytes(input, run, transport.data.body);

  if (!bytes.ok) {
    return bytes;
  }

  return await publish(input, { ...scope, stage: submitted }, artifact, {
    bytes: bytes.data.bytes,
    inputs: plan.data.inputs,
    jobId: bytes.data.jobId,
    producer,
    references: plan.data.references,
    resumed: false,
    run,
    runId,
  });
}

/**
 * The image itself, from a response body. Free on both tracks: gpt-image
 * carries the bytes inline, and a seedream download that already reached the
 * archive is never fetched twice.
 */
async function imageBytes(
  input: GenerateCharacterInput,
  run: ImageRunPaths,
  body: string
): Promise<Result<{ bytes: Buffer; jobId: string | null }>> {
  const answer = readImageResponse(input.track, body);

  if (!answer.ok) {
    return answer;
  }

  if (answer.data.payload.kind === "bytes") {
    return ok({ bytes: answer.data.payload.bytes, jobId: answer.data.jobId });
  }

  const archived = await readDigest(run.image);

  if (archived.ok) {
    return ok({ bytes: archived.data.bytes, jobId: answer.data.jobId });
  }

  const downloaded = await downloadImage({
    fetch: input.fetch,
    url: answer.data.payload.url,
  });

  if (!downloaded.ok) {
    return downloaded;
  }

  await writeNewBytes(run.image, downloaded.data);

  return ok({ bytes: downloaded.data, jobId: answer.data.jobId });
}

async function prepare(
  run: ImageRunPaths,
  data: {
    readonly artifact: CharacterArtifact;
    readonly inputs: readonly RecordedFile[];
    readonly request: ImageRequest;
    readonly runId: string;
  }
): Promise<Result<true>> {
  const prompt = await writeNew(run.prompt, data.request.prompt);

  if (!prompt.ok) {
    return prompt;
  }

  const request = await writeNew(run.request, serialize(archiveRequest(data.request)));

  if (!request.ok) {
    return request;
  }

  // The inputs are referenced, never copied.
  return await writeNew(
    run.run,
    serialize({
      artifact: data.artifact,
      endpoint: data.request.endpoint,
      inputs: data.inputs,
      model: data.request.model,
      promptVersion: PROMPT_VERSION,
      runId: data.runId,
      size: data.request.size,
      stage: STAGE,
      startedAt: nowIso(),
      status: "submitted",
      track: data.request.track,
    })
  );
}

/** The result being replaced, kept only when `--regenerate` replaces it. */
async function previousImage(
  input: GenerateCharacterInput,
  scope: Scope,
  artifact: CharacterArtifact
): Promise<Buffer | null> {
  if (!input.regenerate) {
    return null;
  }

  const path = outputPath(scope.paths, artifact);

  if (!path.ok) {
    return null;
  }

  const digest = await readDigest(path.data);

  return digest.ok ? digest.data.bytes : null;
}

function outputPath(paths: CharacterTrackPaths, artifact: CharacterArtifact): Result<string> {
  if (artifact === "card") {
    return ok(paths.card);
  }

  return artifact === "hero" ? ok(paths.hero) : characterViewImage(paths, artifact);
}

async function publish(
  input: GenerateCharacterInput,
  scope: Scope,
  artifact: CharacterArtifact,
  data: {
    readonly bytes: Buffer;
    readonly inputs: readonly RecordedFile[];
    readonly jobId: string | null;
    readonly producer: ReturnType<typeof modelProducer>;
    readonly references: readonly RecordedFile[];
    readonly resumed: boolean;
    readonly run: ImageRunPaths;
    readonly runId: string;
  }
): Promise<Result<OneResult>> {
  const { size } = sizeOf(artifact);
  const verdict = validateImage(data.bytes, size);
  const target = outputPath(scope.paths, artifact);

  if (!target.ok) {
    return target;
  }

  if (!verdict.ok) {
    await writeNew(
      data.run.validation,
      serialize({
        artifact,
        checkedAt: nowIso(),
        promptVersion: PROMPT_VERSION,
        reason: verdict.error.message,
        structuralValidation: "failed",
      })
    );

    return err(
      new Error(
        `${verdict.error.message}. Odpowiedź zachowano w ${toWorkspacePath(input.workspace.root, data.run.root)} — to błąd formatu wyniku, nie powód do --regenerate.`
      )
    );
  }

  const wantsAlpha = sizeOf(artifact).background === "transparent";

  await writeNew(
    data.run.validation,
    serialize({
      ...verdict.data,
      alphaRequested: wantsAlpha,
      artifact,
      checkedAt: nowIso(),
      promptVersion: PROMPT_VERSION,
      structuralValidation: "passed",
    })
  );

  const outputs: readonly RecordedFile[] = [
    {
      path: toWorkspacePath(input.workspace.root, target.data),
      sha256: sha256Of(data.bytes),
    },
  ];
  const published = withRecord(
    scope.stage,
    artifact,
    newRecord({
      inputs: data.inputs,
      jobId: data.jobId,
      outputs,
      producer: data.producer,
      runId: data.runId,
      status: "completed",
    })
  );

  await writeImage(target.data, data.bytes);
  await write(scope.paths.stage, serialize(published));

  return ok({
    created: [
      toWorkspacePath(input.workspace.root, target.data),
      toWorkspacePath(input.workspace.root, data.run.root),
    ],
    outcome: {
      artifact,
      note: alphaNote(wantsAlpha, verdict.data, input.track, data.resumed),
      prompt: null,
      references: data.references,
      runId: data.runId,
      state: data.resumed ? "resumed" : "published",
      verdict: verdict.data,
    },
    stage: published,
  });
}

/**
 * Transparency is reported, not enforced. gpt-image has a background switch and
 * a view that comes back opaque anyway is a defect worth naming; seedream has
 * none, so there the prompt is the only request and the channel has to be
 * checked rather than assumed. Either way the image is already paid for, so
 * this is a note for the reviewer and never a reason to discard it.
 */
function alphaNote(
  wantsAlpha: boolean,
  verdict: ImageVerdict,
  track: ImageTrack,
  resumed: boolean
): string {
  const prefix = resumed ? "wznowiono z zapisanej odpowiedzi, bez drugiej opłaty; " : "";

  if (!wantsAlpha || verdict.alpha) {
    return `${prefix}${verdict.width}x${verdict.height}, wymiary zgodne z żądaniem`;
  }

  return `${prefix}${verdict.width}x${verdict.height}, ale bez kanału alfa${
    track === "seedream"
      ? " — seedream nie ma przełącznika tła, przezroczystość była proszona wyłącznie w promptcie; oceń krawędzie"
      : " — mimo background=transparent; oceń, czy nadaje się do kompozytowania"
  }`;
}

/** Shared with `check`, which asks the same sequence and layout questions. */
export { accepted, nextGroup, outputPath, readStage, sequenceGate };
