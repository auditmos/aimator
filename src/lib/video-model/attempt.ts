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
import type { ImageAttachment } from "../image-model/index.js";
import { err, ok, type Result } from "../result.js";
import {
  type StillFormat,
  type VideoRunPaths,
  videoRunPaths,
  type Workspace,
} from "../workspace.js";
import {
  archiveRequest,
  buildRequest,
  downloadAsset,
  httpFailure,
  pollVideo,
  refusedWithoutCharge,
  submitVideo,
  type Transport,
  type VideoRequest,
} from "./client.js";
import {
  readSubmitResponse,
  readTaskResponse,
  stillFormat,
  type VideoVerdict,
  validateEndFrame,
  validateVideo,
} from "./validate.js";

/**
 * Internal to the video-model module: one paid clip, start to finish.
 *
 * The order of operations here is the whole contract of a billed job, and it
 * differs from an image's in one place that matters. `submitted` lands on disk
 * before the POST, as everywhere; but the POST answers with an id rather than
 * with the work, so that id is written the moment it exists — before the first
 * poll, before anything can go wrong. An attempt that dies mid-render is then
 * an attempt that can be finished by asking, instead of one that has to be
 * bought again.
 *
 * Nothing retries on its own. Polling is not a retry: the job is already paid
 * for and the provider is rendering it, so asking after it costs nothing and
 * repeating the command picks up exactly where it left off.
 *
 * What a stage brings is everything about *its* artifact: the prompt, the frame
 * the clip starts on, how many seconds it ordered, where the files go and the
 * words it uses for a refusal. The sequence is not its business.
 */

/** Everything a job needs that is not about one particular clip. */
interface VideoCall {
  readonly apiKey: string;
  readonly fetch: typeof fetch;
  readonly model: string;
  /** The only road to a second charge. Nothing here retries on its own. */
  readonly regenerate: boolean;
  /**
   * Publishes an archived answer again, sending nothing and needing neither a
   * model nor a key.
   *
   * It exists because this module has a renderer: it does not only save what
   * the provider sent, it decides what the still that came with the clip is and
   * what to call it. A mistake there shows up *after* publication, on a record
   * that already says `completed`, and the contract is explicit that a bought
   * answer must stay re-derivable for free — otherwise a bug in this file would
   * be billable at the price of a video.
   */
  readonly republish?: boolean;
  /** Where this stage archives: the episode track's `runs/`. */
  readonly runs: string;
  /** Injected so a test never sleeps; the default is the real wait. */
  readonly wait?: (ms: number) => Promise<void>;
  readonly workspace: Workspace;
}

/** The half of an attempt that belongs to one particular clip. */
interface VideoArtifact {
  /** The episode's frame, which the clip inherits through its first frame. */
  readonly aspectRatio: string;
  /** Why a paid call may not happen, in this stage's own error type. */
  readonly blocked: (problems: readonly string[]) => Error;
  /**
   * Where the frame the clip ends on goes, once the provider hands it back.
   *
   * A function of the format rather than a path, because the format is the
   * provider's choice and only `workspace.ts` may turn it into a file name.
   */
  readonly endFrameTarget: (format: StillFormat) => Result<string>;
  /** The one image the request carries: the instant the clip starts on. */
  readonly firstFrame: ImageAttachment;
  readonly inputs: readonly RecordedFile[];
  /** The stage-file key and the artifact's own word: `C01`. */
  readonly key: string;
  readonly prompt: string;
  readonly promptVersion: number;
  /** What the approved shot list planned, and what the request orders. */
  readonly seconds: number;
  readonly stage: StageName;
  readonly stagePath: string;
  /** Where the published clip goes. */
  readonly target: string;
}

interface VideoAttempt {
  /** Workspace-relative paths this attempt wrote, for the report. */
  readonly created: readonly string[];
  /** Whether the provider handed back the frame the next clip continues from. */
  readonly endFrame: boolean;
  /** What happened, in the words a person reads. */
  readonly note: string;
  readonly runId: string;
  /** The stage file as it now stands, with this clip's record in it. */
  readonly stage: StageFile;
  readonly state: "published" | "resumed";
  readonly verdict: VideoVerdict;
}

/** Only the field that decides whether a rejected attempt can have been billed. */
const transportSchema = z.object({ httpStatus: z.number() });

/** How often a job is asked after, and for how long before it is left alone. */
const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 30 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function write(path: string, text: string): Promise<Result<readonly string[]>> {
  return applyWrites([{ kind: "text", text, to: path }], "apply");
}

/**
 * One clip's record, merged into the file rather than replacing it.
 *
 * Stage 7 owns a set: a record per clip and a record per entry frame, in one
 * state file. Replacing the file the way a single-artifact text stage does
 * would erase every record nobody touched.
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
 * One attempt: finish the job that was already paid for, or start a new one.
 *
 * The caller has already decided it may pay. The gates, the model, the key and
 * the lock are the stage's business, and by the time this runs the only thing
 * left to discover is whether an earlier attempt left a job to ask after.
 */
export async function runVideoStage(
  call: VideoCall,
  artifact: VideoArtifact
): Promise<Result<VideoAttempt>> {
  const stage = await readStage(artifact.stagePath, artifact.stage);
  const record = stage.artifacts[artifact.key];

  if (call.republish === true) {
    return record === undefined
      ? err(
          artifact.blocked([`${artifact.key}: nie ma próby, którą można by opublikować ponownie`])
        )
      : await fromArchive(call, artifact, stage, record);
  }

  if (record !== undefined && !call.regenerate) {
    const resumed = await resume(call, artifact, stage, record);

    // `null` means the archived attempt was refused or abandoned rather than
    // billed, so there is nothing to finish and starting over costs nothing.
    if (resumed !== null) {
      return resumed;
    }
  }

  return await attempt(call, artifact, stage);
}

/**
 * Finishes an attempt whose job already reached the provider, without paying
 * again.
 *
 * A `submitted` record with a job id is a clip that is bought: the render
 * either finished while nobody was watching or is still running, and both are
 * answered by asking. Re-deriving the result must cost nothing, because
 * otherwise a bug in the validator would be billable.
 */
async function resume(
  call: VideoCall,
  artifact: VideoArtifact,
  stage: StageFile,
  record: StageFile["artifacts"][string]
): Promise<Result<VideoAttempt> | null> {
  // A finished clip is never bought a second time, whatever the caller asked
  // for. The stage above already declines to ask — but "nothing is billed
  // twice" is this module's promise, not a courtesy it relies on upstream.
  if (record.status === "completed") {
    return err(
      artifact.blocked([
        `${artifact.key}: klip z próby ${record.runId} jest już opublikowany i opłacony`,
        "nową płatną próbę zaczyna wyłącznie --regenerate",
      ])
    );
  }

  const run = videoRunPaths(call, record.runId);
  const archived = await readJson(run.transport, transportSchema);

  // The provider declined to start the job, so nothing was charged and there is
  // nothing to finish. Starting over is safe and needs no `--regenerate`.
  if (archived.ok && refusedWithoutCharge(archived.data.httpStatus)) {
    return null;
  }

  if (record.jobId === null) {
    return err(
      artifact.blocked([
        `próba ${record.runId} zapisała status "submitted" bez identyfikatora zadania — mogła zostać rozliczona`,
        `sprawdź ${toWorkspacePath(call.workspace.root, run.root)}; nową płatną próbę zaczyna wyłącznie --regenerate`,
      ])
    );
  }

  // The job was started for the inputs recorded beside it. Publishing it
  // against changed inputs would attach a result to a question nobody asked.
  const changed = record.inputs.filter(
    (entry) =>
      !artifact.inputs.some((now) => now.path === entry.path && now.sha256 === entry.sha256)
  );

  if (changed.length > 0) {
    return err(
      artifact.blocked([
        ...changed.map((entry) => `${entry.path}: zmienił się od czasu próby ${record.runId}`),
        "uruchomione zadanie opisuje inne wejście — nową płatną próbę zaczyna --regenerate",
      ])
    );
  }

  const finished = await awaitJob(call, artifact, run, record.jobId);

  if (!finished.ok) {
    return finished;
  }

  // A job the provider abandoned was never rendered, so there is nothing to
  // finish and no reason to demand a flag that exists to prevent double
  // charges.
  if ("failed" in finished.data) {
    return null;
  }

  return await publish(call, artifact, stage, {
    jobId: record.jobId,
    producer: record.producer,
    resumed: true,
    run,
    runId: record.runId,
    task: finished.data.done,
  });
}

/**
 * Publishes an archived answer again, without sending anything.
 *
 * It keeps the attempt's `runId` and `producer`, because this is that same
 * attempt: what changed is on this side of the wire. The review goes back to
 * pending, as it does after any write of a result — the files are not the ones
 * somebody accepted, even when the difference is a name.
 */
async function fromArchive(
  call: VideoCall,
  artifact: VideoArtifact,
  stage: StageFile,
  record: StageFile["artifacts"][string]
): Promise<Result<VideoAttempt>> {
  const run = videoRunPaths(call, record.runId);
  const saved = await readDigest(run.response);

  if (!saved.ok) {
    return err(
      artifact.blocked([
        `${artifact.key}: próba ${record.runId} nie zachowała odpowiedzi — nie ma czego opublikować ponownie`,
        "wynik da się odzyskać tylko z archiwum, a to archiwum go nie ma",
      ])
    );
  }

  const task = readTaskResponse(saved.data.bytes.toString("utf8"));

  if (!task.ok) {
    return task;
  }

  if (task.data.kind !== "succeeded") {
    return err(
      artifact.blocked([
        `${artifact.key}: zapisana odpowiedź nie jest ukończonym zadaniem (${task.data.kind})`,
      ])
    );
  }

  return await publish(call, artifact, stage, {
    jobId: record.jobId,
    producer: record.producer,
    resumed: true,
    run,
    runId: record.runId,
    task: { endFrameUrl: task.data.endFrameUrl, videoUrl: task.data.videoUrl },
  });
}

async function attempt(
  call: VideoCall,
  artifact: VideoArtifact,
  stage: StageFile
): Promise<Result<VideoAttempt>> {
  const runId = newRunId();
  const run = videoRunPaths(call, runId);
  const request = buildRequest({
    duration: artifact.seconds,
    firstFrame: artifact.firstFrame,
    model: call.model,
    prompt: artifact.prompt,
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
      await writeNewBytes(run.previousVideo, previous.data.bytes);
    }
  }

  // Submitted lands on disk before the POST. An attempt that dies mid-call is
  // then visibly an attempt that may already have been billed — for this one
  // clip, not for the series around it.
  const submitted = withRecord(
    stage,
    artifact.key,
    newRecord({ inputs: artifact.inputs, outputs: [], producer, runId, status: "submitted" })
  );

  await write(artifact.stagePath, serialize(submitted));

  const transport = await submitVideo({ apiKey: call.apiKey, fetch: call.fetch, request });

  // Nothing reached the provider, so there is nothing to archive.
  if (!transport.ok) {
    return transport;
  }

  await writeNew(run.transport, serialize(transport.data));

  const refused = httpFailure(transport.data);

  if (refused !== null) {
    return err(refused);
  }

  const jobId = readSubmitResponse(transport.data.body);

  if (!jobId.ok) {
    return jobId;
  }

  // The receipt, written before the first poll: from here on the clip can be
  // collected without being bought again.
  const started = withRecord(
    stage,
    artifact.key,
    newRecord({
      inputs: artifact.inputs,
      jobId: jobId.data,
      outputs: [],
      producer,
      runId,
      status: "submitted",
    })
  );

  await write(artifact.stagePath, serialize(started));

  const finished = await awaitJob(call, artifact, run, jobId.data);

  if (!finished.ok) {
    return finished;
  }

  if ("failed" in finished.data) {
    return err(
      artifact.blocked([
        `${artifact.key}: ${finished.data.failed}`,
        "nie zostało wyrenderowane ani rozliczone — powtórz polecenie, --regenerate nie jest potrzebne",
      ])
    );
  }

  return await publish(call, artifact, started, {
    jobId: jobId.data,
    producer,
    resumed: false,
    run,
    runId,
    task: finished.data.done,
  });
}

interface Succeeded {
  readonly endFrameUrl: string | null;
  readonly videoUrl: string;
}

/**
 * How a job ended: with a result, or with the provider's own account of why
 * not. A discriminated pair rather than a nullable result, because the two are
 * acted on differently and the provider's words are the useful half of a
 * failure — "the job failed" is advice nobody can follow.
 */
type Ending = { readonly failed: string } | { readonly done: Succeeded };

/**
 * Waits for one job, asking at a steady interval.
 *
 * `null` means the provider abandoned the job: not rendered, not billed, and
 * therefore safe to start again. A timeout is not an error either in any sense
 * that costs money — the record keeps its job id, so the next run of the same
 * command picks the clip up where this one left it.
 */
async function awaitJob(
  call: VideoCall,
  artifact: VideoArtifact,
  run: VideoRunPaths,
  jobId: string
): Promise<Result<Ending>> {
  const wait = call.wait ?? sleep;
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: polling is the sequence
    const transport = await pollVideo({ apiKey: call.apiKey, fetch: call.fetch, jobId });

    if (!transport.ok) {
      return transport;
    }

    const refused = httpFailure(transport.data);

    if (refused !== null) {
      return err(refused);
    }

    const task = readTaskResponse(transport.data.body);

    if (!task.ok) {
      return task;
    }

    if (task.data.kind === "failed") {
      await archiveAnswer(run, transport.data);

      return ok({ failed: task.data.message });
    }

    if (task.data.kind === "succeeded") {
      await archiveAnswer(run, transport.data);

      return ok({ done: { endFrameUrl: task.data.endFrameUrl, videoUrl: task.data.videoUrl } });
    }

    if (Date.now() >= deadline) {
      return err(
        artifact.blocked([
          `${artifact.key}: zadanie ${jobId} nadal się renderuje (status "${task.data.status}") po ${Math.round(POLL_TIMEOUT_MS / 60_000)} minutach`,
          "jest już opłacone i zapisane — powtórz to samo polecenie, żeby je odebrać; --regenerate kupiłoby drugie",
        ])
      );
    }

    await wait(POLL_INTERVAL_MS);
  }
}

/** The answer that ended the job, archived before it is judged. */
async function archiveAnswer(run: VideoRunPaths, transport: Transport): Promise<void> {
  await writeNew(run.response, transport.body);
}

async function prepare(
  run: VideoRunPaths,
  artifact: VideoArtifact,
  data: { readonly request: VideoRequest; readonly runId: string }
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
      seconds: artifact.seconds,
      stage: artifact.stage,
      startedAt: nowIso(),
      status: "submitted",
    })
  );
}

/** The clip's bytes, from the archive when they are already there. */
async function collect(
  call: VideoCall,
  run: VideoRunPaths,
  task: Succeeded
): Promise<Result<{ endFrame: Buffer | null; video: Buffer }>> {
  const archived = await readDigest(run.video);
  let video = archived.ok ? archived.data.bytes : null;

  if (video === null) {
    const downloaded = await downloadAsset({
      fetch: call.fetch,
      url: task.videoUrl,
      what: "klipu",
    });

    if (!downloaded.ok) {
      return downloaded;
    }

    await writeNewBytes(run.video, downloaded.data);
    video = downloaded.data;
  }

  // Either name, because the format is the provider's choice and an earlier
  // attempt archived the still under whichever one it turned out to be.
  const savedJpeg = await readDigest(run.endFrameJpeg);
  const savedPng = savedJpeg.ok ? savedJpeg : await readDigest(run.endFramePng);

  if (savedPng.ok) {
    return ok({ endFrame: savedPng.data.bytes, video });
  }

  if (task.endFrameUrl === null) {
    return ok({ endFrame: null, video });
  }

  const frame = await downloadAsset({
    fetch: call.fetch,
    url: task.endFrameUrl,
    what: "ostatniej klatki",
  });

  if (!frame.ok) {
    return frame;
  }

  const format = stillFormat(frame.data);

  // Bytes that are neither format are not archived under a name claiming one.
  // They are still handed on: the verdict below refuses them with its own
  // words, and a repeat of the command downloads them again for nothing.
  if (format !== null) {
    await writeNewBytes(format === "jpeg" ? run.endFrameJpeg : run.endFramePng, frame.data);
  }

  return ok({ endFrame: frame.data, video });
}

async function publish(
  call: VideoCall,
  artifact: VideoArtifact,
  stage: StageFile,
  data: {
    readonly jobId: string | null;
    readonly producer: ReturnType<typeof modelProducer>;
    readonly resumed: boolean;
    readonly run: VideoRunPaths;
    readonly runId: string;
    readonly task: Succeeded;
  }
): Promise<Result<VideoAttempt>> {
  const collected = await collect(call, data.run, data.task);

  if (!collected.ok) {
    return collected;
  }

  const verdict = validateVideo(collected.data.video, {
    aspectRatio: artifact.aspectRatio,
    seconds: artifact.seconds,
  });

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
        `${verdict.error.message}. Odpowiedź zachowano w ${toWorkspacePath(call.workspace.root, data.run.root)} — to błąd formatu wyniku, nie powód do --regenerate.`
      )
    );
  }

  // The end frame is judged against the clip it was taken from, because that is
  // the only size it can honestly be compared to: the provider chose the pixels
  // inside its resolution tier, and the frame is that same picture. Its format
  // is the provider's too, so the file is named after what it holds rather than
  // re-encoded into the one the rest of the tree happens to use.
  const still =
    collected.data.endFrame === null
      ? null
      : validateEndFrame(collected.data.endFrame, verdict.data);
  const target = still?.ok === true ? artifact.endFrameTarget(still.data.format) : null;
  const endFrame = target?.ok === true ? collected.data.endFrame : null;
  const outputs: RecordedFile[] = [
    {
      path: toWorkspacePath(call.workspace.root, artifact.target),
      sha256: sha256Of(collected.data.video),
    },
  ];
  const writes = [{ bytes: collected.data.video, kind: "bytes" as const, to: artifact.target }];

  if (endFrame !== null && target?.ok === true) {
    outputs.push({
      path: toWorkspacePath(call.workspace.root, target.data),
      sha256: sha256Of(endFrame),
    });
    writes.push({ bytes: endFrame, kind: "bytes" as const, to: target.data });
  }

  await writeNew(
    data.run.validation,
    serialize({
      ...verdict.data,
      artifact: artifact.key,
      checkedAt: nowIso(),
      endFrame: endFrame !== null,
      promptVersion: artifact.promptVersion,
      structuralValidation: "passed",
    })
  );

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

  await applyWrites(writes, "apply");
  await write(artifact.stagePath, serialize(published));

  return ok({
    created: [
      ...writes.map((one) => toWorkspacePath(call.workspace.root, one.to)),
      toWorkspacePath(call.workspace.root, data.run.root),
    ],
    endFrame: endFrame !== null,
    note: note(verdict.data, endFrame !== null, data.resumed),
    runId: data.runId,
    stage: published,
    state: data.resumed ? "resumed" : "published",
    verdict: verdict.data,
  });
}

function note(verdict: VideoVerdict, endFrame: boolean, resumed: boolean): string {
  const prefix = resumed ? "odebrano opłacone zadanie, bez drugiej opłaty; " : "";
  const frame = endFrame
    ? ""
    : " — bez końcówki: dostawca nie zwrócił ostatniej klatki, więc klip kontynuujący nie ma z czego wyjść";

  return `${prefix}${verdict.width}x${verdict.height}, ${verdict.seconds}s${frame}`;
}
