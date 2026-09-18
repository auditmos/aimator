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
  removeFile,
  type StageFile,
  type StageName,
  serialize,
  stageFileSchema,
  toWorkspacePath,
  writeNew,
} from "../artifact/index.js";
import { err, ok, type Result } from "../result.js";
import type { EpisodePaths, RunPaths, Workspace } from "../workspace.js";
import { runPaths } from "../workspace.js";
import {
  buildRequest,
  callModel,
  ENDPOINT,
  httpFailure,
  type ResponseFormat,
  readOutputText,
  refusedWithoutCharge,
} from "./client.js";

/**
 * Internal to the text-model module: one billed text call, start to finish.
 *
 * Promoted here when stage 4 became the *third* text stage to repeat the same
 * dance — take the lock, archive the prompt and the request, write `submitted`
 * before the POST, archive whatever came back, resume from a saved answer
 * instead of paying twice, publish only what validates. Stages 1 and 3 had two
 * copies of it that had already begun to differ in their comments; a third copy
 * is how an invariant becomes a coincidence.
 *
 * What stays with the stage is everything that is about *its* artifact: the
 * prompt, the structural verdict, the files it writes and the words it uses for
 * them. What lives here is the order of operations, which is the contract.
 *
 * Nothing here knows what a valid result looks like or where an artifact goes.
 */

/** Everything the lifecycle needs that is not about one particular artifact. */
interface TextCall {
  readonly apiKey: string;
  readonly episode: EpisodePaths;
  readonly fetch: typeof fetch;
  /** A schema the provider enforces, or `null` for a plain Markdown answer. */
  readonly format: ResponseFormat | null;
  readonly maxOutputTokens: number;
  readonly model: string;
  /** The only road to a second charge. Nothing here retries on its own. */
  readonly regenerate: boolean;
  readonly workspace: Workspace;
}

/** What one stage's `publish` was handed, and what it hands back. */
export interface Publication {
  readonly archive: RunPaths;
  readonly jobId: string | null;
  /** The document the provider returned, lifted out of the payload. */
  readonly text: string;
}

export interface Published<T> {
  /** Workspace-relative paths this stage wrote, for the report. */
  readonly created: readonly string[];
  readonly outputs: readonly RecordedFile[];
  /** The stage's own verdict, carried back to its caller untouched. */
  readonly value: T;
}

/** The half of an attempt that belongs to one particular stage. */
export interface TextStage<T> {
  /** The stage-file key, the `stage` field and the file name, in one word. */
  readonly artifact: StageName;
  /** Why a paid call may not happen, in this stage's own error type. */
  readonly blocked: (problems: readonly string[]) => Error;
  readonly inputs: readonly RecordedFile[];
  readonly lock: string;
  /**
   * Copies the results this attempt is about to replace into `previous/`.
   * Called only under `--regenerate`, which is the only way to reach a paid
   * call with a finished result already on disk.
   */
  readonly preserve: (archive: RunPaths) => Promise<void>;
  readonly prompt: string;
  readonly promptVersion: number;
  /** Turns the paid text into artifacts, or says why it may not be published. */
  readonly publish: (input: Publication) => Promise<Result<Published<T>>>;
  /** The primary artifact, named when a finished one already exists. */
  readonly result: string;
  readonly stagePath: string;
  /** Names the artifact in a provider-error message: "scenariusz", "pakiet". */
  readonly what: string;
}

interface TextAttempt<T> {
  readonly created: readonly string[];
  readonly runId: string;
  readonly value: T;
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

/** Only the field that decides whether a rejected attempt can have been billed. */
const transportSchema = z.object({ httpStatus: z.number() });

function write(path: string, text: string): Promise<Result<readonly string[]>> {
  return applyWrites([{ kind: "text", text, to: path }], "apply");
}

function stageFile(artifact: StageName, record: StageFile["artifacts"][string]): string {
  return serialize({ ...emptyStage(artifact), artifacts: { [artifact]: record } });
}

/**
 * One attempt, under a lock, with the order of operations the contract fixes.
 *
 * The caller has already decided it may pay: the gates, the model and the key
 * are the command's business, and by the time this runs there is nothing left
 * to refuse except a result that already exists.
 */
export async function runTextStage<T>(
  call: TextCall,
  stage: TextStage<T>
): Promise<Result<TextAttempt<T>>> {
  const lock = await writeNew(stage.lock, serialize({ pid: process.pid, startedAt: nowIso() }));

  if (!lock.ok) {
    return err(new LockError(stage.lock));
  }

  try {
    return await attempt(call, stage);
  } finally {
    await removeFile(stage.lock);
  }
}

async function attempt<T>(call: TextCall, stage: TextStage<T>): Promise<Result<TextAttempt<T>>> {
  const previousStage = await readJson(stage.stagePath, stageFileSchema);
  const record = previousStage.ok ? previousStage.data.artifacts[stage.artifact] : undefined;

  if (record !== undefined && !call.regenerate) {
    const resumed = await resume(call, stage, record);

    if (resumed !== null) {
      return resumed;
    }
  }

  const runId = newRunId();
  const archive = runPaths(call.episode, runId);
  const request = buildRequest({
    format: call.format,
    maxOutputTokens: call.maxOutputTokens,
    model: call.model,
    prompt: stage.prompt,
  });
  const producer = modelProducer({
    endpoint: ENDPOINT,
    model: call.model,
    promptVersion: stage.promptVersion,
  });

  const prepared = await prepare(archive, call, stage, { request: serialize(request), runId });

  if (!prepared.ok) {
    return prepared;
  }

  // The previous result is kept only when a regeneration replaces it.
  if (call.regenerate) {
    await stage.preserve(archive);
  }

  // Submitted lands on disk before the POST. An attempt that dies mid-call is
  // then visibly an attempt that may already have been billed.
  await write(
    stage.stagePath,
    stageFile(
      stage.artifact,
      newRecord({ inputs: stage.inputs, outputs: [], producer, runId, status: "submitted" })
    )
  );

  const transport = await callModel({ apiKey: call.apiKey, fetch: call.fetch, request });

  // Nothing reached the provider, so there is nothing to archive.
  if (!transport.ok) {
    return transport;
  }

  // Archived before it is judged. A refusal nobody can read is worse than the
  // refusal itself, and every text stage promises the diagnostics are kept.
  await writeNew(archive.transport, serialize(transport.data));
  await writeNew(archive.response, transport.data.body);

  const refused = httpFailure(transport.data);

  if (refused !== null) {
    return err(refused);
  }

  return await publish(call, stage, {
    archive,
    body: transport.data.body,
    producer,
    runId,
  });
}

/**
 * What to do with an attempt that already exists. `null` means "nothing —
 * go ahead and pay".
 *
 * A `submitted` record whose archive still holds the response is the case this
 * exists for: that answer is bought and paid for, so re-deriving a verdict from
 * it must cost nothing. Otherwise a bug in a validator would be billable, and
 * the first one was. This is not an automatic retry — nothing is sent.
 */
async function resume<T>(
  call: TextCall,
  stage: TextStage<T>,
  record: StageFile["artifacts"][string]
): Promise<Result<TextAttempt<T>> | null> {
  if (record.status === "completed") {
    return err(
      stage.blocked([
        `${stage.what} dla tego odcinka już istnieje (${toWorkspacePath(call.workspace.root, stage.result)})`,
        "zachowano poprzedni wynik; nową płatną próbę zaczyna wyłącznie --regenerate",
      ])
    );
  }

  const archive = runPaths(call.episode, record.runId);
  const saved = await readJson(archive.transport, transportSchema);
  const status = saved.ok ? saved.data.httpStatus : null;

  // The provider declined to do the work, so nothing was charged and there is
  // nothing to finish. Starting over is safe and needs no `--regenerate`:
  // demanding one would make a rejected request look like a paid one.
  if (status !== null && refusedWithoutCharge(status)) {
    return null;
  }

  const response = await readDigest(archive.response);

  // A 429 or a 5xx may have started work that was billed, so those keep the
  // rule that protects against paying twice.
  if (!response.ok || (status !== null && status >= 400)) {
    return err(
      stage.blocked([
        `próba ${record.runId} zapisała status "submitted", ale nie ma z niej użytecznej odpowiedzi${status === null ? "" : ` (HTTP ${status})`} — mogła zostać rozliczona`,
        "wywołanie idzie ze store: false, więc nie ma zadania do odpytania; nową płatną próbę zaczyna wyłącznie --regenerate",
      ])
    );
  }

  // The saved answer was written for the inputs recorded beside it. Publishing
  // it against changed inputs would attach a result to a question nobody asked.
  const changed = record.inputs.filter(
    (entry) => !stage.inputs.some((now) => now.path === entry.path && now.sha256 === entry.sha256)
  );

  if (changed.length > 0) {
    return err(
      stage.blocked([
        ...changed.map((entry) => `${entry.path}: zmienił się od czasu próby ${record.runId}`),
        "zapisana odpowiedź opisuje inne wejście — nową płatną próbę zaczyna --regenerate",
      ])
    );
  }

  return await publish(call, stage, {
    archive,
    body: response.data.bytes.toString("utf8"),
    producer: record.producer,
    runId: record.runId,
  });
}

async function prepare<T>(
  archive: RunPaths,
  call: TextCall,
  stage: TextStage<T>,
  data: { readonly request: string; readonly runId: string }
): Promise<Result<true>> {
  const written = await writeNew(archive.prompt, stage.prompt);

  if (!written.ok) {
    return written;
  }

  const request = await writeNew(archive.request, data.request);

  if (!request.ok) {
    return request;
  }

  // The inputs are referenced, never copied: a run archive that duplicated them
  // would keep a second copy of every source file for every attempt.
  return await writeNew(
    archive.run,
    serialize({
      endpoint: ENDPOINT,
      inputs: stage.inputs,
      maxOutputTokens: call.maxOutputTokens,
      model: call.model,
      promptVersion: stage.promptVersion,
      runId: data.runId,
      stage: stage.artifact,
      startedAt: nowIso(),
      status: "submitted",
    })
  );
}

/**
 * Lifts the document out of the payload, hands it to the stage, and records
 * `completed` only over outputs the stage actually wrote.
 */
async function publish<T>(
  call: TextCall,
  stage: TextStage<T>,
  data: {
    readonly archive: RunPaths;
    readonly body: string;
    readonly producer: StageFile["artifacts"][string]["producer"];
    readonly runId: string;
  }
): Promise<Result<TextAttempt<T>>> {
  const parsed = readOutputText(data.body, stage.what);

  if (!parsed.ok) {
    return parsed;
  }

  const published = await stage.publish({
    archive: data.archive,
    jobId: parsed.data.jobId,
    text: parsed.data.text,
  });

  if (!published.ok) {
    return published;
  }

  await write(
    stage.stagePath,
    stageFile(
      stage.artifact,
      newRecord({
        inputs: stage.inputs,
        jobId: parsed.data.jobId,
        outputs: published.data.outputs,
        producer: data.producer,
        runId: data.runId,
        status: "completed",
      })
    )
  );

  return ok({
    created: [
      ...published.data.created,
      toWorkspacePath(call.workspace.root, stage.stagePath),
      toWorkspacePath(call.workspace.root, data.archive.root),
    ],
    runId: data.runId,
    value: published.data.value,
  });
}
