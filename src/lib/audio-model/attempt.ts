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
import { type AudioRunPaths, audioRunPaths, type Workspace } from "../workspace.js";
import {
  type AudioKind,
  type AudioRequest,
  archiveRequest,
  buildRequest,
  callAudio,
  httpFailure,
  refusedWithoutCharge,
} from "./client.js";
import { type AudioVerdict, validateAudio } from "./validate.js";

/**
 * Internal to the audio-model module: one paid audio call, start to finish.
 *
 * The order of operations is the one `lib/image-model` wrote down and
 * `lib/voice-model` repeated, because it genuinely is the same order:
 * `submitted` lands on disk before the POST, so an attempt that dies mid-call
 * is visibly one that may already have been charged — for this one stem, not
 * for the sheet around it. Nothing retries on its own.
 *
 * Resuming costs nothing, which this shares with an image or a speech call and
 * not with a clip: the provider answers with the audio itself, so an archived
 * answer *is* the stem. A validator bug must never be billable — and here that
 * matters more than usual, because the charge lands at generation rather than
 * at download, so a second attempt is a second full price.
 *
 * `promptVersion` stays null, as it does for speech, and for a reason worth
 * stating because it looks like the opposite case. A speech call carries the
 * film's own words, so a version number on them would be a claim about
 * authorship. An audio call carries an instruction — but not one of *ours*: it
 * is a cue somebody approved in `sound-design.md`, and what answers "which
 * instruction produced these bytes" is that file's digest, recorded among the
 * inputs. A constant's version number would point at the wrong document.
 */

/** Everything a call needs that is not about one particular cue. */
interface AudioCall {
  readonly apiKey: string;
  readonly fetch: typeof fetch;
  /** The only road to a second charge. Nothing here retries on its own. */
  readonly regenerate: boolean;
  /** Where this stage archives: the episode's shared `runs/`. */
  readonly runs: string;
  readonly workspace: Workspace;
}

/** The half of an attempt that belongs to one particular cue. */
interface AudioArtifact {
  /** Why a paid call may not happen, in this stage's own error type. */
  readonly blocked: (problems: readonly string[]) => Error;
  readonly inputs: readonly RecordedFile[];
  /** Whether the bed must be free of singing. Derived by the stage. */
  readonly instrumental: boolean;
  /** The stage-file key and the cue's own word: `M01`, `E02`. */
  readonly key: string;
  readonly kind: AudioKind;
  /** Which model composes or renders this one. */
  readonly model: string;
  /** What the provider rates: the length of audio asked for. */
  readonly seconds: number;
  readonly stage: StageName;
  readonly stagePath: string;
  /** Where the published MP3 goes. */
  readonly target: string;
  /** The cue itself, in English. */
  readonly text: string;
}

interface AudioAttempt {
  /** Workspace-relative paths this attempt wrote, for the report. */
  readonly created: readonly string[];
  /** What happened, in the words a person reads. */
  readonly note: string;
  readonly runId: string;
  /** What this stem was rated on, in the unit the provider actually uses. */
  readonly seconds: number;
  /** The stage file as it now stands, with this cue's record in it. */
  readonly stage: StageFile;
  readonly state: "published" | "resumed";
  readonly verdict: AudioVerdict;
}

/** Only the field that decides whether a rejected attempt can have been billed. */
const transportSchema = z.object({ httpStatus: z.number() });

function write(path: string, text: string): Promise<Result<readonly string[]>> {
  return applyWrites([{ kind: "text", text, to: path }], "apply");
}

/**
 * One cue's record, merged into the file rather than replacing it.
 *
 * Stage 10 owns a set — the sheet, the bed and one record per effect — so
 * replacing the file the way a single-artifact text stage does would erase
 * every record nobody touched.
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
async function archivedStatus(run: AudioRunPaths): Promise<number | null> {
  const saved = await readJson(run.transport, transportSchema);

  return saved.ok ? saved.data.httpStatus : null;
}

/**
 * One attempt: finish the one that was already paid for, or start a new one.
 *
 * The caller has already decided it may pay. The gates, the models, the key
 * and the lock are the stage's business, and by the time this runs the only
 * thing left to discover is whether an earlier attempt left something to
 * salvage.
 */
export async function runAudioStage(
  call: AudioCall,
  artifact: AudioArtifact
): Promise<Result<AudioAttempt>> {
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

/** Finishes an attempt that already reached the provider, without paying again. */
async function resume(
  call: AudioCall,
  artifact: AudioArtifact,
  stage: StageFile,
  record: StageFile["artifacts"][string]
): Promise<Result<AudioAttempt> | null> {
  const run = audioRunPaths(call, record.runId);
  const status = await archivedStatus(run);

  // The provider declined to do the work, so nothing was charged and there is
  // nothing to finish. Starting over is safe and needs no `--regenerate`.
  if (status !== null && refusedWithoutCharge(status)) {
    return null;
  }

  const saved = await readDigest(run.audio);

  // A 429 or a 5xx may have started work that was billed, so those keep the
  // rule that protects against paying twice.
  if (!saved.ok || (status !== null && status >= 400)) {
    return err(
      artifact.blocked([
        `próba ${record.runId} zapisała status "submitted", ale nie ma z niej dźwięku${status === null ? "" : ` (HTTP ${status})`} — mogła zostać rozliczona`,
        `sprawdź ${toWorkspacePath(call.workspace.root, run.root)}; nową płatną próbę zaczyna wyłącznie --regenerate`,
      ])
    );
  }

  // The saved stem was composed from the cue recorded beside it. Publishing it
  // against a changed sheet would attach music to a direction nobody gave.
  const changed = record.inputs.filter(
    (entry) =>
      !artifact.inputs.some((now) => now.path === entry.path && now.sha256 === entry.sha256)
  );

  if (changed.length > 0) {
    return err(
      artifact.blocked([
        ...changed.map((entry) => `${entry.path}: zmienił się od czasu próby ${record.runId}`),
        "zapisany stem powstał z innego cue — nową płatną próbę zaczyna --regenerate",
      ])
    );
  }

  return await publish(call, artifact, stage, {
    audio: saved.data.bytes,
    producer: record.producer,
    resumed: true,
    run,
    runId: record.runId,
  });
}

async function attempt(
  call: AudioCall,
  artifact: AudioArtifact,
  stage: StageFile
): Promise<Result<AudioAttempt>> {
  const runId = newRunId();
  const run = audioRunPaths(call, runId);
  const request = buildRequest({
    instrumental: artifact.instrumental,
    kind: artifact.kind,
    model: artifact.model,
    seconds: artifact.seconds,
    text: artifact.text,
  });
  const producer = modelProducer({
    endpoint: request.endpoint,
    model: artifact.model,
    promptVersion: null,
  });
  const prepared = await prepare(run, artifact, { request, runId });

  if (!prepared.ok) {
    return prepared;
  }

  // The previous stem is kept only when a regeneration replaces it.
  if (call.regenerate) {
    const previous = await readDigest(artifact.target);

    if (previous.ok) {
      await writeNewBytes(run.previousAudio, previous.data.bytes);
    }
  }

  // Submitted lands on disk before the POST. An attempt that dies mid-call is
  // then visibly an attempt that may already have been billed — for this one
  // stem, not for the whole sheet.
  const submitted = withRecord(
    stage,
    artifact.key,
    newRecord({ inputs: artifact.inputs, outputs: [], producer, runId, status: "submitted" })
  );

  await write(artifact.stagePath, serialize(submitted));

  const transport = await callAudio({ apiKey: call.apiKey, fetch: call.fetch, request });

  // Nothing reached the provider, so there is nothing to archive.
  if (!transport.ok) {
    return transport;
  }

  // Archived before it is judged. A refusal nobody can read is worse than the
  // refusal itself, and this module promises the diagnostics are kept.
  await writeNew(
    run.transport,
    serialize({
      bytes: transport.data.audio?.length ?? null,
      httpStatus: transport.data.httpStatus,
      receivedAt: transport.data.receivedAt,
      requestId: transport.data.requestId,
    })
  );

  if (transport.data.body !== null) {
    await writeNew(run.response, transport.data.body);
  }

  const refused = httpFailure(transport.data);

  if (refused !== null) {
    return err(refused);
  }

  if (transport.data.audio === null) {
    return err(artifact.blocked(["API odpowiedziało bez dźwięku i bez błędu"]));
  }

  await writeNewBytes(run.audio, transport.data.audio);

  return await publish(call, artifact, submitted, {
    audio: transport.data.audio,
    producer,
    resumed: false,
    run,
    runId,
  });
}

async function prepare(
  run: AudioRunPaths,
  artifact: AudioArtifact,
  data: { readonly request: AudioRequest; readonly runId: string }
): Promise<Result<true>> {
  // The cue as it was sent. It is the prompt of this call in every sense that
  // matters, so it is archived under the name every other stage uses.
  const prompt = await writeNew(run.prompt, data.request.text);

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
      kind: data.request.kind,
      model: data.request.model,
      runId: data.runId,
      // The unit this provider actually rates: seconds of generated audio.
      seconds: data.request.seconds,
      stage: artifact.stage,
      startedAt: nowIso(),
      status: "submitted",
    })
  );
}

async function publish(
  call: AudioCall,
  artifact: AudioArtifact,
  stage: StageFile,
  data: {
    readonly audio: Buffer;
    readonly producer: ReturnType<typeof modelProducer>;
    readonly resumed: boolean;
    readonly run: AudioRunPaths;
    readonly runId: string;
  }
): Promise<Result<AudioAttempt>> {
  const verdict = validateAudio(data.audio);

  if (!verdict.ok) {
    await writeNew(
      data.run.validation,
      serialize({
        artifact: artifact.key,
        checkedAt: nowIso(),
        reason: verdict.error.message,
        structuralValidation: "failed",
      })
    );

    return err(
      new Error(
        `${verdict.error.message}. Odpowiedź zachowano w ${toWorkspacePath(call.workspace.root, data.run.root)} — to błąd formatu wyniku, nie powód do --regenerate.`
      )
    );
  }

  await writeNew(
    data.run.validation,
    serialize({
      ...verdict.data,
      artifact: artifact.key,
      checkedAt: nowIso(),
      // What came back beside what was asked for. Stated rather than enforced:
      // what to do about the difference is the laying stage's decision.
      orderedSeconds: artifact.seconds,
      structuralValidation: "passed",
    })
  );

  const outputs: readonly RecordedFile[] = [
    { path: toWorkspacePath(call.workspace.root, artifact.target), sha256: sha256Of(data.audio) },
  ];
  const published = withRecord(
    stage,
    artifact.key,
    newRecord({
      inputs: artifact.inputs,
      outputs,
      producer: data.producer,
      runId: data.runId,
      status: "completed",
    })
  );

  await applyWrites([{ bytes: data.audio, kind: "bytes", to: artifact.target }], "apply");
  await write(artifact.stagePath, serialize(published));

  return ok({
    created: [
      toWorkspacePath(call.workspace.root, artifact.target),
      toWorkspacePath(call.workspace.root, data.run.root),
    ],
    note: `${data.resumed ? "wznowiono z zapisanego dźwięku, bez drugiej opłaty; " : ""}zamówiono ${artifact.seconds}s, wróciło ${verdict.data.seconds}s`,
    runId: data.runId,
    seconds: artifact.seconds,
    stage: published,
    state: data.resumed ? "resumed" : "published",
    verdict: verdict.data,
  });
}
