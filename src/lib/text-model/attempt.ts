import { z } from "zod";
import {
  applyWrites,
  driftableInputs,
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
  sha256Of,
  stageFileSchema,
  toWorkspacePath,
  writeNew,
} from "../artifact/index.js";
import { err, ok, type Result } from "../result.js";
import type { EpisodePaths, RunPaths, Workspace } from "../workspace.js";
import { archivedBy, previousFile, runPaths } from "../workspace.js";
import {
  buildRequest,
  callModel,
  ENDPOINT,
  httpFailure,
  type ResponseFormat,
  readOutputText,
  refusedWithoutCharge,
} from "./client.js";
import { type Replaced, revisionPrompt } from "./revision.js";

/**
 * Internal to the text-model module: one billed text call, start to finish.
 *
 * Promoted here when stage 4 became the *third* text stage to repeat the same
 * dance, take the lock, archive the prompt and the request, write `submitted`
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
  /**
   * A person's note on the published version, or `null`. Only with
   * `regenerate`: the attempt then corrects the version it replaces instead of
   * redrawing it, and that version becomes one of its inputs.
   */
  readonly instruction: string | null;
  readonly maxOutputTokens: number;
  readonly model: string;
  /** The only road to a second charge. Nothing here retries on its own. */
  readonly regenerate: boolean;
  /**
   * Publish the archived answer again, sending nothing.
   *
   * The contract already says a bought answer must be re-derivable for free,
   * otherwise a bug in a validator would be billable. That held only while a
   * record was `submitted`; a stage whose *renderer* turns out wrong is found
   * after the record is `completed`, and re-deriving was then possible only by
   * paying for a second identical answer. This is that same right, for the
   * mistakes that surface one step later.
   */
  readonly republish: boolean;
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
  /**
   * The `stage` field of the file this writes, and the file's own name.
   *
   * Separate from `key` since stage 9, which is the first text stage whose
   * state file holds more than one artifact: its shared file carries the script
   * and every bought utterance, so "which stage wrote this" and "which record
   * is this" stopped being one word. For stages 1, 3 and 4 they are still the
   * same word, and nothing about those stages changed.
   */
  readonly artifact: StageName;
  /** Why a paid call may not happen, in this stage's own error type. */
  readonly blocked: (problems: readonly string[]) => Error;
  readonly inputs: readonly RecordedFile[];
  /**
   * The record this attempt owns, inside that file. Defaults to the stage name,
   * which is what every text stage before stage 9 meant by it.
   */
  readonly key?: string;
  readonly lock: string;
  readonly prompt: string;
  readonly promptVersion: number;
  /** Turns the paid text into artifacts, or says why it may not be published. */
  readonly publish: (input: Publication) => Promise<Result<Published<T>>>;
  /**
   * The files this attempt would replace, as they stand, named relative to the
   * episode. Read only under `--regenerate`, which is the only way to reach a
   * paid call with a finished result already on disk; this module keeps them
   * in `previous/`, and under `--instruction` they are what gets corrected.
   */
  readonly replaced: () => Promise<readonly Replaced[]>;
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
      `inna próba trzyma blokadę ${path}, po awarii upewnij się, że poprzedni proces nie działa, zanim usuniesz ten plik`
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

/**
 * This attempt's record, merged into the file rather than replacing it.
 *
 * A text stage used to own exactly one artifact, so writing the whole file was
 * the same thing as writing its record. Stage 9 broke that: its shared file
 * holds the script beside every line bought from it, and replacing the file
 * when the script is re-lifted would erase recordings somebody paid for, the
 * failure `lib/image-model` avoids for the same reason, ten images down.
 */
async function writeRecord<T>(
  stage: TextStage<T>,
  record: StageFile["artifacts"][string]
): Promise<void> {
  const previous = await readJson(stage.stagePath, stageFileSchema);
  const artifacts = previous.ok ? previous.data.artifacts : {};

  await write(
    stage.stagePath,
    serialize({
      ...emptyStage(stage.artifact),
      artifacts: { ...artifacts, [stage.key ?? stage.artifact]: record },
    })
  );
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
  // Before anything else: a note must never ride on a resume or a republication,
  // which would publish an answer that was never shown it.
  if (call.instruction !== null && !call.regenerate) {
    return err(
      stage.blocked(["--instruction poprawia opublikowany wynik, więc działa tylko z --regenerate"])
    );
  }

  const previousStage = await readJson(stage.stagePath, stageFileSchema);
  const record = previousStage.ok
    ? previousStage.data.artifacts[stage.key ?? stage.artifact]
    : undefined;

  if (call.republish) {
    return await republish(call, stage, record);
  }

  if (record !== undefined && !call.regenerate) {
    const resumed = await resume(call, stage, record);

    if (resumed !== null) {
      return resumed;
    }
  }

  const runId = newRunId();
  const archive = runPaths(call.episode, runId);
  // Read before anything is written: under `--instruction` these are both
  // what the request quotes and what this attempt records as an input.
  const replaced = call.regenerate ? await stage.replaced() : [];
  const revised = revision(stage, replaced, call.instruction);

  if (!revised.ok) {
    return revised;
  }

  const kept = keptFiles(call.workspace, archive, replaced);

  if (!kept.ok) {
    return kept;
  }

  // The previous version is an input only of an attempt that was shown it.
  const inputs = call.instruction === null ? stage.inputs : [...stage.inputs, ...kept.data.inputs];
  const request = buildRequest({
    format: call.format,
    maxOutputTokens: call.maxOutputTokens,
    model: call.model,
    prompt: revised.data,
  });
  const producer = modelProducer({
    endpoint: ENDPOINT,
    model: call.model,
    promptVersion: stage.promptVersion,
  });

  const prepared = await prepare(archive, call, stage, {
    inputs,
    prompt: revised.data,
    request: serialize(request),
    runId,
  });

  if (!prepared.ok) {
    return prepared;
  }

  // The previous result is kept only when a regeneration replaces it, and it
  // is kept once: referenced from here, never copied anywhere else.
  for (const file of kept.data.writes) {
    // biome-ignore lint/performance/noAwaitInLoops: a handful of small files
    await writeNew(file.to, file.text);
  }

  // Submitted lands on disk before the POST. An attempt that dies mid-call is
  // then visibly an attempt that may already have been billed.
  await writeRecord(
    stage,
    newRecord({
      inputs,
      instruction: call.instruction,
      outputs: [],
      producer,
      runId,
      status: "submitted",
    })
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
    inputs,
    instruction: call.instruction,
    producer,
    runId,
  });
}

/** The prompt this attempt sends: the stage's own, or a correction of `replaced`. */
function revision<T>(
  stage: TextStage<T>,
  replaced: readonly Replaced[],
  instruction: string | null
): Result<string> {
  if (instruction === null) {
    return ok(stage.prompt);
  }

  return replaced.length === 0
    ? err(stage.blocked(nothingToRevise(stage.what)))
    : ok(revisionPrompt(stage.prompt, replaced, instruction));
}

function nothingToRevise(what: string): readonly string[] {
  return [
    `nie ma opublikowanej wersji (${what}), którą --instruction mógłby poprawić; pierwszą kupuje generate bez tej flagi`,
  ];
}

/**
 * The text a paid call would send, for a preview that sends nothing.
 *
 * Under `--instruction` it is the correction of the version on disk, read the
 * way the paid call reads it, so a preview cannot show one request while the
 * purchase sends another. A missing version is a problem to report rather than
 * an error, because a dry run is where a person finds out what stands in the way.
 */
export async function textPrompt<T>(
  stage: TextStage<T>,
  instruction: string | null
): Promise<{ readonly problems: readonly string[]; readonly prompt: string }> {
  const replaced = instruction === null ? [] : await stage.replaced();
  const revised = revision(stage, replaced, instruction);

  return revised.ok
    ? { problems: [], prompt: revised.data }
    : { problems: nothingToRevise(stage.what), prompt: stage.prompt };
}

/** Where each replaced file lands in `previous/`, and what it is as an input. */
function keptFiles(
  workspace: Workspace,
  archive: RunPaths,
  replaced: readonly Replaced[]
): Result<{
  readonly inputs: readonly RecordedFile[];
  readonly writes: readonly { readonly text: string; readonly to: string }[];
}> {
  const inputs: RecordedFile[] = [];
  const writes: { text: string; to: string }[] = [];

  for (const file of replaced) {
    const to = previousFile(archive, file.name);

    if (!to.ok) {
      return to;
    }

    writes.push({ text: file.text, to: to.data });
    inputs.push({
      path: toWorkspacePath(workspace.root, to.data),
      sha256: sha256Of(Buffer.from(file.text)),
    });
  }

  return ok({ inputs, writes });
}

/**
 * The inputs a saved attempt is published against: the stage's as they stand,
 * plus the version it corrected, which lives in its own `previous/`. That one
 * is part of the archive, never rewritten, so it cannot drift and is not
 * compared against anything.
 */
function archivedInputs(record: StageFile["artifacts"][string]): readonly RecordedFile[] {
  return record.inputs.filter((entry) => archivedBy(record.runId, entry.path));
}

/**
 * Publishes the archived answer again, sending nothing and charging nothing.
 *
 * The run id and the producer are kept: this is the same attempt, and its
 * `promptVersion` still names the prompt that really produced the answer. What
 * changed is on this side, a validator or a renderer, and pretending a new
 * attempt happened would put a date and an id on work nobody did.
 *
 * It refuses on drifted inputs for the reason `resume` does: the saved answer
 * was written for the inputs recorded beside it, and attaching it to different
 * ones would answer a question nobody asked.
 */
async function republish<T>(
  call: TextCall,
  stage: TextStage<T>,
  record: StageFile["artifacts"][string] | undefined
): Promise<Result<TextAttempt<T>>> {
  if (record === undefined) {
    return err(
      stage.blocked([
        `nie ma czego opublikować ponownie, ${stage.what} nie ma jeszcze żadnej próby`,
      ])
    );
  }

  const archive = runPaths(call.episode, record.runId);
  const response = await readDigest(archive.response);

  if (!response.ok) {
    return err(
      stage.blocked([
        `próba ${record.runId} nie zachowała odpowiedzi, więc nie ma z czego publikować`,
        "bez zapisanej odpowiedzi jedyną drogą dalej jest --regenerate, czyli druga opłata",
      ])
    );
  }

  const changed = driftableInputs(record).filter(
    (entry) => !stage.inputs.some((now) => now.path === entry.path && now.sha256 === entry.sha256)
  );

  if (changed.length > 0) {
    return err(
      stage.blocked([
        ...changed.map((entry) => `${entry.path}: zmienił się od czasu próby ${record.runId}`),
        "zapisana odpowiedź opisuje inne wejście, nową płatną próbę zaczyna --regenerate",
      ])
    );
  }

  return await publish(call, stage, {
    archive,
    body: response.data.bytes.toString("utf8"),
    inputs: [...stage.inputs, ...archivedInputs(record)],
    instruction: record.instruction,
    producer: record.producer,
    runId: record.runId,
  });
}

/**
 * What to do with an attempt that already exists. `null` means "nothing,
 * go ahead and pay".
 *
 * A `submitted` record whose archive still holds the response is the case this
 * exists for: that answer is bought and paid for, so re-deriving a verdict from
 * it must cost nothing. Otherwise a bug in a validator would be billable, and
 * the first one was. This is not an automatic retry; nothing is sent.
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
        `próba ${record.runId} zapisała status "submitted", ale nie ma z niej użytecznej odpowiedzi${status === null ? "" : ` (HTTP ${status})`}, mogła zostać rozliczona`,
        "wywołanie idzie ze store: false, więc nie ma zadania do odpytania; nową płatną próbę zaczyna wyłącznie --regenerate",
      ])
    );
  }

  // The saved answer was written for the inputs recorded beside it. Publishing
  // it against changed inputs would attach a result to a question nobody asked.
  const changed = driftableInputs(record).filter(
    (entry) => !stage.inputs.some((now) => now.path === entry.path && now.sha256 === entry.sha256)
  );

  if (changed.length > 0) {
    return err(
      stage.blocked([
        ...changed.map((entry) => `${entry.path}: zmienił się od czasu próby ${record.runId}`),
        "zapisana odpowiedź opisuje inne wejście, nową płatną próbę zaczyna --regenerate",
      ])
    );
  }

  return await publish(call, stage, {
    archive,
    body: response.data.bytes.toString("utf8"),
    inputs: [...stage.inputs, ...archivedInputs(record)],
    instruction: record.instruction,
    producer: record.producer,
    runId: record.runId,
  });
}

async function prepare<T>(
  archive: RunPaths,
  call: TextCall,
  stage: TextStage<T>,
  data: {
    readonly inputs: readonly RecordedFile[];
    readonly prompt: string;
    readonly request: string;
    readonly runId: string;
  }
): Promise<Result<true>> {
  const written = await writeNew(archive.prompt, data.prompt);

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
      artifact: stage.key ?? stage.artifact,
      endpoint: ENDPOINT,
      inputs: data.inputs,
      instruction: call.instruction,
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
    readonly inputs: readonly RecordedFile[];
    readonly instruction: string | null;
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

  await writeRecord(
    stage,
    newRecord({
      inputs: data.inputs,
      instruction: data.instruction,
      jobId: parsed.data.jobId,
      outputs: published.data.outputs,
      producer: data.producer,
      runId: data.runId,
      status: "completed",
    })
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
