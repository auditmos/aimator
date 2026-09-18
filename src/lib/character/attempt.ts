import {
  applyWrites,
  modelProducer,
  newRecord,
  newRunId,
  nowIso,
  type RecordedFile,
  readDigest,
  type StageFile,
  serialize,
  sha256Of,
  toWorkspacePath,
  writeNew,
  writeNewBytes,
} from "../artifact/index.js";
import { err, ok, type Result } from "../result.js";
import {
  type ImageRunPaths,
  type ImageTrack,
  imageRunPaths,
  type Workspace,
} from "../workspace.js";
import {
  archiveRequest,
  buildRequest,
  callImage,
  downloadImage,
  type ImageRequest,
  sizeOf,
} from "./client.js";
import { buildPlan, outputPath, type Scope, Stage2BlockedError, withRecord } from "./plan.js";
import { type CharacterArtifact, PROMPT_VERSION } from "./prompt.js";
import { type ImageVerdict, readImageResponse, validateImage } from "./validate.js";

/**
 * Internal to the character module: one paid attempt, start to finish.
 *
 * The order of operations here is the whole contract of a billed call.
 * `submitted` lands on disk before the POST, so an attempt that dies mid-call
 * is visibly one that may already have been charged — for this one image, not
 * for the series around it. Nothing retries on its own.
 *
 * Resuming costs nothing, which is what separates this stage from stage 1.
 * gpt-image returns the bytes inline, so a saved response body *is* the image;
 * seedream returns a URL good for 24 hours, so a saved body is a second,
 * unbilled chance to fetch it. `--regenerate` stays the last resort rather
 * than the only way forward.
 */

/** The one stage name this module writes. */
const STAGE = "character";

/** What an attempt needs from the command that called it. */
interface AttemptInput {
  readonly apiKey: string | null;
  readonly fetch: typeof fetch;
  readonly model: string | null;
  readonly regenerate: boolean;
  readonly track: ImageTrack;
  readonly workspace: Workspace;
}

/** What happened to one of the ten, in the words a person reads. */
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

export interface OneResult {
  readonly created: readonly string[];
  readonly outcome: ArtifactOutcome;
  readonly stage: StageFile;
}

function write(path: string, text: string): Promise<Result<readonly string[]>> {
  return applyWrites([{ kind: "text", text, to: path }], "apply");
}

function writeImage(path: string, bytes: Buffer): Promise<Result<readonly string[]>> {
  return applyWrites([{ bytes, kind: "bytes", to: path }], "apply");
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
export async function resume(
  input: AttemptInput,
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

export async function attempt(
  input: AttemptInput,
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
  input: AttemptInput,
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
  input: AttemptInput,
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

async function publish(
  input: AttemptInput,
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
