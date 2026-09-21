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
import { type VoiceRunPaths, voiceRunPaths, type Workspace } from "../workspace.js";
import {
  archiveRequest,
  buildRequest,
  callSpeech,
  httpFailure,
  refusedWithoutCharge,
  type SpeechContext,
  type SpeechDelivery,
  type SpeechRequest,
} from "./client.js";
import {
  billedCharacters,
  contextCharacters,
  type SpeechVerdict,
  validateSpeech,
} from "./validate.js";

/**
 * Internal to the voice-model module: one paid speech call, start to finish.
 *
 * The order of operations here is the whole contract of a billed call, and it
 * is the one `lib/image-model` already wrote down: `submitted` lands on disk
 * before the POST, so an attempt that dies mid-call is visibly one that may
 * already have been charged, for this one line, not for the script around it.
 * Nothing retries on its own.
 *
 * Resuming costs nothing, which is what a speech call has in common with an
 * image one and not with a clip: the provider answers with the audio itself, so
 * an archived answer *is* the line. A validator bug must never be billable.
 *
 * The `producer` records the voice beside the model, because this record
 * answers one question, what would have to run again to get these bytes, and
 * for speech the honest answer is both. `promptVersion` stays null: nothing of
 * ours is an instruction here. The text is the film's own words, travelling
 * verbatim, and a version number on somebody else's sentence would be a lie
 * about who wrote it.
 */

/** Everything a call needs that is not about one particular utterance. */
interface VoiceCall {
  readonly apiKey: string;
  /** How the narrator performs. The stage stores it; this module only sends it. */
  readonly delivery: SpeechDelivery;
  readonly fetch: typeof fetch;
  readonly model: string;
  /** The only road to a second charge. Nothing here retries on its own. */
  readonly regenerate: boolean;
  /** Where this stage archives: the episode's shared `runs/`. */
  readonly runs: string;
  /** Which voice reads the series, from `project.json`. */
  readonly voiceId: string;
  readonly workspace: Workspace;
}

/** The half of an attempt that belongs to one particular utterance. */
interface VoiceArtifact {
  /** Why a paid call may not happen, in this stage's own error type. */
  readonly blocked: (problems: readonly string[]) => Error;
  /** What is said either side of this line, derived by the stage from its script. */
  readonly context: SpeechContext;
  readonly inputs: readonly RecordedFile[];
  /** The stage-file key and the utterance's own word: `N01`, `N02`. */
  readonly key: string;
  readonly stage: StageName;
  readonly stagePath: string;
  /** Where the published WAV goes. */
  readonly target: string;
  /** The sentence, verbatim, in the film's language. */
  readonly text: string;
}

interface VoiceAttempt {
  /** What this line cost, in the unit the provider actually charges. */
  readonly characters: number;
  /** Workspace-relative paths this attempt wrote, for the report. */
  readonly created: readonly string[];
  /** What happened, in the words a person reads. */
  readonly note: string;
  readonly runId: string;
  /** The stage file as it now stands, with this utterance's record in it. */
  readonly stage: StageFile;
  readonly state: "published" | "resumed";
  readonly verdict: SpeechVerdict;
}

/** Only the field that decides whether a rejected attempt can have been billed. */
const transportSchema = z.object({ httpStatus: z.number() });

function write(path: string, text: string): Promise<Result<readonly string[]>> {
  return applyWrites([{ kind: "text", text, to: path }], "apply");
}

/**
 * One utterance's record, merged into the file rather than replacing it.
 *
 * Stage 9 owns a set, the script and one record per line, so replacing the
 * file the way a single-artifact text stage does would erase every record
 * nobody touched.
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

/**
 * The seed this attempt asks for, derived from the attempt's own id.
 *
 * Derived rather than stored, and from the run id rather than from the
 * sentence, because the two things a seed has to do pull in opposite
 * directions. Re-deriving the reading of a *recorded* attempt must give the
 * same request, and the run id is recorded, so it does. But `--regenerate`
 * exists because somebody did not like what came back, and a seed fixed to the
 * sentence would hand them the same reading for a second charge. A new attempt
 * gets a new id, so it gets a new seed.
 */
function seedFrom(runId: string): number {
  return Number.parseInt(sha256Of(Buffer.from(runId, "utf8")).slice(0, 8), 16);
}

/** The HTTP status an earlier attempt archived, or `null` if it archived none. */
async function archivedStatus(run: VoiceRunPaths): Promise<number | null> {
  const saved = await readJson(run.transport, transportSchema);

  return saved.ok ? saved.data.httpStatus : null;
}

/**
 * One attempt: finish the one that was already paid for, or start a new one.
 *
 * The caller has already decided it may pay. The gates, the model, the voice,
 * the key and the lock are the stage's business, and by the time this runs the
 * only thing left to discover is whether an earlier attempt left something to
 * salvage.
 */
export async function runVoiceStage(
  call: VoiceCall,
  artifact: VoiceArtifact
): Promise<Result<VoiceAttempt>> {
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
 * A `submitted` record whose archive holds the audio is a line that is bought
 * and paid for. Re-deriving the result from it must cost nothing, because
 * otherwise a bug in the validator would be billable.
 */
async function resume(
  call: VoiceCall,
  artifact: VoiceArtifact,
  stage: StageFile,
  record: StageFile["artifacts"][string]
): Promise<Result<VoiceAttempt> | null> {
  const run = voiceRunPaths(call, record.runId);
  const status = await archivedStatus(run);

  // The provider declined to do the work, so nothing was charged and there is
  // nothing to finish. Starting over is safe and needs no `--regenerate`:
  // demanding one would make a rejected request look like a paid one.
  if (status !== null && refusedWithoutCharge(status)) {
    return null;
  }

  const saved = await readDigest(run.audio);

  // A 429 or a 5xx may have started work that was billed, so those keep the
  // rule that protects against paying twice.
  if (!saved.ok || (status !== null && status >= 400)) {
    return err(
      artifact.blocked([
        `próba ${record.runId} zapisała status "submitted", ale nie ma z niej nagrania${status === null ? "" : ` (HTTP ${status})`}, mogła zostać rozliczona`,
        `sprawdź ${toWorkspacePath(call.workspace.root, run.root)}; nową płatną próbę zaczyna wyłącznie --regenerate`,
      ])
    );
  }

  // The saved line was read from the script recorded beside it. Publishing it
  // against a changed script would attach a recording to a sentence nobody
  // asked for, and here that is not a subtlety: it would put words in the
  // film that the approved script does not contain.
  const changed = record.inputs.filter(
    (entry) =>
      !artifact.inputs.some((now) => now.path === entry.path && now.sha256 === entry.sha256)
  );

  if (changed.length > 0) {
    return err(
      artifact.blocked([
        ...changed.map((entry) => `${entry.path}: zmienił się od czasu próby ${record.runId}`),
        "zapisane nagranie czyta inne zdanie, nową płatną próbę zaczyna --regenerate",
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
  call: VoiceCall,
  artifact: VoiceArtifact,
  stage: StageFile
): Promise<Result<VoiceAttempt>> {
  const runId = newRunId();
  const run = voiceRunPaths(call, runId);
  const request = buildRequest({
    context: artifact.context,
    delivery: call.delivery,
    model: call.model,
    seed: seedFrom(runId),
    text: artifact.text,
    voiceId: call.voiceId,
  });
  const producer = modelProducer({
    endpoint: request.endpoint,
    // The voice is half the answer to "what would have to run again", so it is
    // recorded beside the model rather than left to the request archive, which
    // a pruned workspace may not still hold.
    model: `${call.model} / voice ${call.voiceId}`,
    promptVersion: null,
  });
  const prepared = await prepare(run, artifact, { request, runId });

  if (!prepared.ok) {
    return prepared;
  }

  // The previous recording is kept only when a regeneration replaces it.
  if (call.regenerate) {
    const previous = await readDigest(artifact.target);

    if (previous.ok) {
      await writeNewBytes(run.previousAudio, previous.data.bytes);
    }
  }

  // Submitted lands on disk before the POST. An attempt that dies mid-call is
  // then visibly an attempt that may already have been billed, for this one
  // line, not for the whole script.
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

  const transport = await callSpeech({ apiKey: call.apiKey, fetch: call.fetch, request });

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
    return err(artifact.blocked(["API odpowiedziało bez nagrania i bez błędu"]));
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
  run: VoiceRunPaths,
  artifact: VoiceArtifact,
  data: { readonly request: SpeechRequest; readonly runId: string }
): Promise<Result<true>> {
  // The sentence as it was sent. It is the prompt of this call in every sense
  // that matters, so it is archived under the name every other stage uses.
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
      characters: billedCharacters(data.request.text),
      // Counted apart from the bill, never added to it. The provider documents
      // the context parameters but does not say whether they are charged for,
      // and a tool that guessed would be guessing with somebody else's money.
      contextCharacters: contextCharacters(data.request.context),
      delivery: data.request.delivery,
      endpoint: data.request.endpoint,
      inputs: artifact.inputs,
      model: data.request.model,
      runId: data.runId,
      seed: data.request.seed,
      stage: artifact.stage,
      startedAt: nowIso(),
      status: "submitted",
      voiceId: data.request.voiceId,
    })
  );
}

async function publish(
  call: VoiceCall,
  artifact: VoiceArtifact,
  stage: StageFile,
  data: {
    readonly audio: Buffer;
    readonly producer: ReturnType<typeof modelProducer>;
    readonly resumed: boolean;
    readonly run: VoiceRunPaths;
    readonly runId: string;
  }
): Promise<Result<VoiceAttempt>> {
  const verdict = validateSpeech(data.audio);

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
        `${verdict.error.message}. Odpowiedź zachowano w ${toWorkspacePath(call.workspace.root, data.run.root)}, to błąd formatu wyniku, nie powód do --regenerate.`
      )
    );
  }

  const characters = billedCharacters(artifact.text);

  await writeNew(
    data.run.validation,
    serialize({
      ...verdict.data,
      artifact: artifact.key,
      characters,
      checkedAt: nowIso(),
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
    characters,
    created: [
      toWorkspacePath(call.workspace.root, artifact.target),
      toWorkspacePath(call.workspace.root, data.run.root),
    ],
    note: `${data.resumed ? "wznowiono z zapisanego nagrania, bez drugiej opłaty; " : ""}${verdict.data.seconds}s, ${characters} znaków`,
    runId: data.runId,
    stage: published,
    state: data.resumed ? "resumed" : "published",
    verdict: verdict.data,
  });
}
