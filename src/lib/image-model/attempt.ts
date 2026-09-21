import { z } from "zod";
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
  type StageFile,
  type StageName,
  serialize,
  sha256Of,
  stageFileSchema,
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
  httpFailure,
  type ImageAttachment,
  type ImageRequest,
  refusedWithoutCharge,
} from "./client.js";
import { type ImageVerdict, readImageResponse, validateImage } from "./validate.js";

/**
 * Internal to the image-model module: one paid image call, start to finish.
 *
 * The order of operations here is the whole contract of a billed call.
 * `submitted` lands on disk before the POST, so an attempt that dies mid-call
 * is visibly one that may already have been charged, for this one image, not
 * for the series around it. Nothing retries on its own.
 *
 * Resuming costs nothing, which is what separates an image stage from a text
 * one. gpt-image returns the bytes inline, so a saved response body *is* the
 * image; seedream returns a URL good for 24 hours, so a saved body is a second,
 * unbilled chance to fetch it. `--regenerate` stays the last resort rather than
 * the only way forward.
 *
 * What a stage brings is everything about *its* artifact: the prompt, the
 * attachments it chose, the frame, where the file goes and the words it uses
 * for a refusal. The sequence is not its business.
 */

/** Everything a call needs that is not about one particular artifact. */
interface ImageCall {
  readonly apiKey: string;
  readonly fetch: typeof fetch;
  readonly model: string;
  /** The only road to a second charge. Nothing here retries on its own. */
  readonly regenerate: boolean;
  /** Where this stage archives: a character's `runs/`, or an episode track's. */
  readonly runs: string;
  readonly track: ImageTrack;
  readonly workspace: Workspace;
}

/** The half of an attempt that belongs to one particular artifact. */
interface ImageArtifact {
  /** The ordered bytes the request carries, already resolved and verified. */
  readonly attachments: readonly ImageAttachment[];
  /** `opaque` or `transparent`. The stage decides; the API is told. */
  readonly background: string;
  /** Why a paid call may not happen, in this stage's own error type. */
  readonly blocked: (problems: readonly string[]) => Error;
  readonly inputs: readonly RecordedFile[];
  /** The stage-file key and the artifact's own word: `card`, `hero`, `R01`. */
  readonly key: string;
  readonly prompt: string;
  readonly promptVersion: number;
  /** The frame the request asks for, and what the verdict compares against. */
  readonly size: string;
  readonly stage: StageName;
  readonly stagePath: string;
  /** Where the published PNG goes. */
  readonly target: string;
}

interface ImageAttempt {
  /** Workspace-relative paths this attempt wrote, for the report. */
  readonly created: readonly string[];
  /** What happened, in the words a person reads. */
  readonly note: string;
  readonly runId: string;
  /** The stage file as it now stands, with this artifact's record in it. */
  readonly stage: StageFile;
  readonly state: "published" | "resumed";
  readonly verdict: ImageVerdict;
}

/** Only the field that decides whether a rejected attempt can have been billed. */
const transportSchema = z.object({ httpStatus: z.number() });

function write(path: string, text: string): Promise<Result<readonly string[]>> {
  return applyWrites([{ kind: "text", text, to: path }], "apply");
}

/**
 * One artifact's record, merged into the file rather than replacing it.
 *
 * An image stage owns a set: ten for a character, one per reference for an
 * episode. Replacing the file the way a single-artifact text stage does would
 * erase the nine records nobody touched.
 */
function withRecord(
  stage: StageFile,
  key: string,
  record: StageFile["artifacts"][string]
): StageFile {
  return { ...stage, artifacts: { ...stage.artifacts, [key]: record } };
}

async function readStage(path: string, name: StageName): Promise<StageFile> {
  const stage = await readJson(path, stageFileSchema);

  return stage.ok ? stage.data : emptyStage(name);
}

/** The HTTP status an earlier attempt archived, or `null` if it archived none. */
async function archivedStatus(run: ImageRunPaths): Promise<number | null> {
  const saved = await readJson(run.transport, transportSchema);

  return saved.ok ? saved.data.httpStatus : null;
}

/**
 * One attempt: finish the one that was already paid for, or start a new one.
 *
 * The caller has already decided it may pay. The gates, the model, the key and
 * the lock are the stage's business, and by the time this runs the only thing
 * left to discover is whether an earlier attempt left something to salvage.
 */
export async function runImageStage(
  call: ImageCall,
  artifact: ImageArtifact
): Promise<Result<ImageAttempt>> {
  const stage = await readStage(artifact.stagePath, artifact.stage);
  const record = stage.artifacts[artifact.key];

  if (record !== undefined && !call.regenerate) {
    const resumed = await resume(call, artifact, stage, record);

    // `null` means the archived attempt was refused rather than billed, so
    // there is nothing to finish and starting over costs nothing.
    if (resumed !== null) {
      return resumed;
    }
  }

  return await attempt(call, artifact, stage);
}

/**
 * Finishes an attempt that already reached the provider, without paying again.
 *
 * A `submitted` record whose archive holds the response is an image that is
 * bought and paid for. gpt-image put the bytes in that body; seedream put a URL
 * that lives 24 hours. Re-deriving the result from either must cost nothing,
 * because otherwise a bug in the validator would be billable.
 */
async function resume(
  call: ImageCall,
  artifact: ImageArtifact,
  stage: StageFile,
  record: StageFile["artifacts"][string]
): Promise<Result<ImageAttempt> | null> {
  const run = imageRunPaths(call, record.runId);
  const status = await archivedStatus(run);

  // The provider declined to do the work, so nothing was charged and there is
  // nothing to finish. Starting over is safe and needs no `--regenerate`:
  // demanding one would make a rejected request look like a paid one.
  if (status !== null && refusedWithoutCharge(status)) {
    return null;
  }

  const saved = await readDigest(run.response);

  // An answer is only worth publishing when the provider actually answered.
  // A 429 or a 5xx may have started work that was billed, so those keep the
  // rule that protects against paying twice.
  if (!saved.ok || (status !== null && status >= 400)) {
    return err(
      artifact.blocked([
        `próba ${record.runId} zapisała status "submitted", ale nie ma z niej użytecznej odpowiedzi${status === null ? "" : ` (HTTP ${status})`}, mogła zostać rozliczona`,
        `sprawdź ${toWorkspacePath(call.workspace.root, run.root)}; nową płatną próbę zaczyna wyłącznie --regenerate`,
      ])
    );
  }

  // The saved answer was drawn for the inputs recorded beside it. Publishing it
  // against changed inputs would attach a result to a question nobody asked.
  const changed = record.inputs.filter(
    (entry) =>
      !artifact.inputs.some((now) => now.path === entry.path && now.sha256 === entry.sha256)
  );

  if (changed.length > 0) {
    return err(
      artifact.blocked([
        ...changed.map((entry) => `${entry.path}: zmienił się od czasu próby ${record.runId}`),
        "zapisana odpowiedź opisuje inne wejście, nową płatną próbę zaczyna --regenerate",
      ])
    );
  }

  const bytes = await imageBytes(call, run, saved.data.bytes.toString("utf8"));

  if (!bytes.ok) {
    return bytes;
  }

  return await publish(call, artifact, stage, {
    bytes: bytes.data.bytes,
    jobId: bytes.data.jobId,
    producer: record.producer,
    resumed: true,
    run,
    runId: record.runId,
  });
}

async function attempt(
  call: ImageCall,
  artifact: ImageArtifact,
  stage: StageFile
): Promise<Result<ImageAttempt>> {
  const runId = newRunId();
  const run = imageRunPaths(call, runId);
  const request = buildRequest({
    attachments: artifact.attachments,
    background: artifact.background,
    model: call.model,
    prompt: artifact.prompt,
    size: artifact.size,
    track: call.track,
  });
  const producer = modelProducer({
    endpoint: request.endpoint,
    model: call.model,
    promptVersion: artifact.promptVersion,
  });
  const prepared = await prepare(run, artifact, { request, runId });

  if (!prepared.ok) {
    return prepared;
  }

  // The previous result is kept only when a regeneration replaces it.
  if (call.regenerate) {
    const previous = await readDigest(artifact.target);

    if (previous.ok) {
      await writeNewBytes(run.previousImage, previous.data.bytes);
    }
  }

  // Submitted lands on disk before the POST. An attempt that dies mid-call is
  // then visibly an attempt that may already have been billed, for this one
  // image, not for the whole series.
  const submitted = withRecord(
    stage,
    artifact.key,
    newRecord({
      inputs: artifact.inputs,
      outputs: [],
      producer,
      runId,
      status: "submitted",
    })
  );

  await write(artifact.stagePath, serialize(submitted));

  const transport = await callImage({ apiKey: call.apiKey, fetch: call.fetch, request });

  // Nothing reached the provider, so there is nothing to archive.
  if (!transport.ok) {
    return transport;
  }

  // Archived before it is judged. A refusal nobody can read is worse than the
  // refusal itself, and this module promises the diagnostics are kept.
  await writeNew(run.transport, serialize(transport.data));
  await writeNew(run.response, transport.data.body);

  const refused = httpFailure(transport.data);

  if (refused !== null) {
    return err(refused);
  }

  const bytes = await imageBytes(call, run, transport.data.body);

  if (!bytes.ok) {
    return bytes;
  }

  return await publish(call, artifact, submitted, {
    bytes: bytes.data.bytes,
    jobId: bytes.data.jobId,
    producer,
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
  call: ImageCall,
  run: ImageRunPaths,
  body: string
): Promise<Result<{ bytes: Buffer; jobId: string | null }>> {
  const answer = readImageResponse(call.track, body);

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

  const downloaded = await downloadImage({ fetch: call.fetch, url: answer.data.payload.url });

  if (!downloaded.ok) {
    return downloaded;
  }

  await writeNewBytes(run.image, downloaded.data);

  return ok({ bytes: downloaded.data, jobId: answer.data.jobId });
}

async function prepare(
  run: ImageRunPaths,
  artifact: ImageArtifact,
  data: { readonly request: ImageRequest; readonly runId: string }
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
      artifact: artifact.key,
      endpoint: data.request.endpoint,
      inputs: artifact.inputs,
      model: data.request.model,
      promptVersion: artifact.promptVersion,
      runId: data.runId,
      size: data.request.size,
      stage: artifact.stage,
      startedAt: nowIso(),
      status: "submitted",
      track: data.request.track,
    })
  );
}

async function publish(
  call: ImageCall,
  artifact: ImageArtifact,
  stage: StageFile,
  data: {
    readonly bytes: Buffer;
    readonly jobId: string | null;
    readonly producer: ReturnType<typeof modelProducer>;
    readonly resumed: boolean;
    readonly run: ImageRunPaths;
    readonly runId: string;
  }
): Promise<Result<ImageAttempt>> {
  const verdict = validateImage(data.bytes, artifact.size);

  if (!verdict.ok) {
    await writeNew(
      data.run.validation,
      serialize({
        artifact: artifact.key,
        checkedAt: nowIso(),
        promptVersion: artifact.promptVersion,
        reason: verdict.error.message,
        structuralValidation: "failed",
      })
    );

    return err(
      new Error(
        `${verdict.error.message}. Odpowiedź zachowano w ${toWorkspacePath(call.workspace.root, data.run.root)}, to błąd formatu wyniku, nie powód do --regenerate.`
      )
    );
  }

  const wantsAlpha = artifact.background === "transparent";

  await writeNew(
    data.run.validation,
    serialize({
      ...verdict.data,
      alphaRequested: wantsAlpha,
      artifact: artifact.key,
      checkedAt: nowIso(),
      promptVersion: artifact.promptVersion,
      structuralValidation: "passed",
    })
  );

  const outputs: readonly RecordedFile[] = [
    { path: toWorkspacePath(call.workspace.root, artifact.target), sha256: sha256Of(data.bytes) },
  ];
  const published = withRecord(
    stage,
    artifact.key,
    newRecord({
      inputs: artifact.inputs,
      jobId: data.jobId,
      outputs,
      producer: data.producer,
      runId: data.runId,
      status: "completed",
    })
  );

  await applyWrites([{ bytes: data.bytes, kind: "bytes", to: artifact.target }], "apply");
  await write(artifact.stagePath, serialize(published));

  return ok({
    created: [
      toWorkspacePath(call.workspace.root, artifact.target),
      toWorkspacePath(call.workspace.root, data.run.root),
    ],
    note: alphaNote(wantsAlpha, verdict.data, call.track, data.resumed),
    runId: data.runId,
    stage: published,
    state: data.resumed ? "resumed" : "published",
    verdict: verdict.data,
  });
}

/**
 * Transparency is reported, not enforced. gpt-image has a background switch and
 * an image that comes back opaque anyway is a defect worth naming; seedream has
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
      ? ", seedream nie ma przełącznika tła, przezroczystość była proszona wyłącznie w promptcie; oceń krawędzie"
      : ", mimo background=transparent; oceń, czy nadaje się do kompozytowania"
  }`;
}
