import { z } from "zod";
import {
  AnswerFormatError,
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
import type { Muxer } from "../muxer.js";
import { err, ok, type Result } from "../result.js";
import {
  type StillFormat,
  type VideoRunPaths,
  videoRunPaths,
  type Workspace,
} from "../workspace.js";
import {
  downloadAsset,
  httpFailure,
  pollVideo,
  refusedWithoutCharge,
  submitVideo,
  type Transport,
  type VideoRequest,
} from "./client.js";
import { type JobWire, providerOf, type VideoProvider } from "./provider.js";
import { stillFormat, type VideoVerdict, validateEndFrame, validateVideo } from "./validate.js";

/**
 * Internal to the video-model module: one paid clip, start to finish.
 *
 * The order of operations here is the whole contract of a billed job, and it
 * differs from an image's in one place that matters. `submitted` lands on disk
 * before the POST, as everywhere; but the POST answers with an id rather than
 * with the work, so that id is written the moment it exists, before the first
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
 *
 * A clip is one kind of job and a lip-sync is the other. They differ in what is
 * sent, how the answers read and what a result must be to be published, and in
 * nothing else, so `runJob` is the sequence once and each kind is an adapter
 * that brings its order, its wire and its verdict.
 */

/** Everything a job needs that is not about one particular clip. */
interface VideoCall {
  readonly apiKey: string;
  readonly fetch: typeof fetch;
  /**
   * A person's note on the previous take, or absent. It is already quoted in
   * the prompt; this module only records it, because no provider edits a
   * finished video and the request is otherwise an ordinary new job.
   */
  readonly instruction?: string | null;
  readonly model: string;
  /**
   * The local engine, for a provider that hands back no final frame: the frame
   * is then cut out of the downloaded clip, before anything judges it.
   */
  readonly mux: Muxer;
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
   * answer must stay re-derivable for free, otherwise a bug in this file would
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

/**
 * What every kind of job needs that is not about one artifact. The engine is
 * optional here because only a wire that cuts the end frame out of the result
 * uses it, and only a clip's wire does.
 */
export type JobCall = Omit<VideoCall, "mux"> & { readonly mux?: Muxer };

/** The half of an attempt that belongs to one artifact, whatever kind of job buys it. */
interface JobArtifact {
  readonly blocked: (problems: readonly string[]) => Error;
  /** Where a frame handed back or cut out goes; never asked of a wire without one. */
  readonly endFrameTarget: (format: StillFormat) => Result<string>;
  readonly inputs: readonly RecordedFile[];
  readonly key: string;
  readonly promptVersion: number | null;
  /** What the job is expected to last, recorded in `run.json`. */
  readonly seconds: number;
  readonly stage: StageName;
  readonly stagePath: string;
  readonly target: string;
  /** Whether a downloaded result is the one that was ordered; it is published only if so. */
  readonly verdict: (video: Buffer) => Result<VideoVerdict>;
}

/** What one new job sends, as sent and as archived. */
interface Order {
  readonly archive: unknown;
  readonly body: unknown;
  readonly endpoint: string;
  /** Written to the archive as `prompt.md`; `null` for a job that carries no prompt. */
  readonly prompt: string | null;
}

/** How a kind of job finds its wire for a model, and what it sends on it. */
interface JobKind<W extends JobWire> {
  readonly order: (wire: W) => Order;
  readonly wireOf: (model: string) => Result<W>;
}

export interface VideoAttempt {
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
  return await runJob(
    call,
    {
      ...artifact,
      verdict: (video) =>
        validateVideo(video, { aspectRatio: artifact.aspectRatio, seconds: artifact.seconds }),
    },
    {
      order: (provider: VideoProvider) => {
        const request: VideoRequest = {
          duration: artifact.seconds,
          endpoint: provider.endpoint(call.model),
          firstFrame: artifact.firstFrame,
          model: call.model,
          prompt: artifact.prompt,
        };

        return {
          archive: provider.archive(request),
          body: provider.body(request),
          endpoint: request.endpoint,
          prompt: request.prompt,
        };
      },
      wireOf: providerOf,
    }
  );
}

/** The sequence around any kind of job: republish, resume, or a new attempt. */
export async function runJob<W extends JobWire>(
  call: JobCall,
  artifact: JobArtifact,
  kind: JobKind<W>
): Promise<Result<VideoAttempt>> {
  const stage = await readStage(artifact.stagePath, artifact.stage);
  const record = stage.artifacts[artifact.key];

  if (call.republish === true) {
    if (record === undefined) {
      return err(
        artifact.blocked([`${artifact.key}: nie ma próby, którą można by opublikować ponownie`])
      );
    }

    // The archive is read in the dialect of whoever wrote it, which is the
    // model the record names, not whatever model this shell happens to pick.
    const wire = kind.wireOf(record.producer.model ?? "");

    return wire.ok
      ? await fromArchive(call, wire.data, artifact, stage, record)
      : err(artifact.blocked([`${artifact.key}: ${wire.error.message}`]));
  }

  const wire = kind.wireOf(call.model);

  if (!wire.ok) {
    return err(artifact.blocked([wire.error.message]));
  }

  if (record !== undefined && !call.regenerate) {
    const resumed = await resume(call, wire.data, artifact, stage, record);

    // `null` means the archived attempt was refused or abandoned rather than
    // billed, so there is nothing to finish and starting over costs nothing.
    if (resumed !== null) {
      return resumed;
    }
  }

  return await attempt(call, wire.data, kind.order(wire.data), artifact, stage);
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
  call: JobCall,
  wire: JobWire,
  artifact: JobArtifact,
  stage: StageFile,
  record: StageFile["artifacts"][string]
): Promise<Result<VideoAttempt> | null> {
  // A finished clip is never bought a second time, whatever the caller asked
  // for. The stage above already declines to ask, but "nothing is billed
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
        `próba ${record.runId} zapisała status "submitted" bez identyfikatora zadania, mogła zostać rozliczona`,
        `sprawdź ${toWorkspacePath(call.workspace.root, run.root)}; nową płatną próbę zaczyna wyłącznie --regenerate`,
      ])
    );
  }

  // A job is collected from the provider that started it, with that
  // provider's key. Another model in this shell is not a reason to buy again,
  // and asking the wrong provider about the receipt would only get a 404.
  if (record.producer.model !== call.model) {
    return err(
      artifact.blocked([
        `${artifact.key}: zadanie ${record.jobId} zamówiono u modelu ${record.producer.model ?? "nieznanego"}, a to polecenie wskazuje ${call.model}`,
        `odbierz je tym samym modelem: --video-model ${record.producer.model ?? ""}; nową płatną próbę innym modelem zaczyna wyłącznie --regenerate`,
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
        "uruchomione zadanie opisuje inne wejście, nową płatną próbę zaczyna --regenerate",
      ])
    );
  }

  const finished = await awaitJob(call, wire, artifact, run, record.jobId);

  if (!finished.ok) {
    return finished;
  }

  // A job the provider abandoned was never rendered, so there is nothing to
  // finish and no reason to demand a flag that exists to prevent double
  // charges.
  if ("failed" in finished.data) {
    return null;
  }

  return await publish(call, wire, artifact, stage, {
    instruction: record.instruction,
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
 * pending, as it does after any write of a result, the files are not the ones
 * somebody accepted, even when the difference is a name.
 */
async function fromArchive(
  call: JobCall,
  wire: JobWire,
  artifact: JobArtifact,
  stage: StageFile,
  record: StageFile["artifacts"][string]
): Promise<Result<VideoAttempt>> {
  const run = videoRunPaths(call, record.runId);
  const saved = await readDigest(run.response);

  if (!saved.ok) {
    return err(
      artifact.blocked([
        `${artifact.key}: próba ${record.runId} nie zachowała odpowiedzi, nie ma czego opublikować ponownie`,
        "wynik da się odzyskać tylko z archiwum, a to archiwum go nie ma",
      ])
    );
  }

  const task = wire.readTask(saved.data.bytes.toString("utf8"));

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

  return await publish(call, wire, artifact, stage, {
    instruction: record.instruction,
    jobId: record.jobId,
    producer: record.producer,
    resumed: true,
    run,
    runId: record.runId,
    task: { endFrameUrl: task.data.endFrameUrl, videoUrl: task.data.videoUrl },
  });
}

async function attempt(
  call: JobCall,
  wire: JobWire,
  order: Order,
  artifact: JobArtifact,
  stage: StageFile
): Promise<Result<VideoAttempt>> {
  const runId = newRunId();
  const run = videoRunPaths(call, runId);
  const producer = modelProducer({
    endpoint: order.endpoint,
    model: call.model,
    promptVersion: artifact.promptVersion,
  });
  const prepared = await prepare(run, artifact, { model: call.model, order, runId });

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
  // then visibly an attempt that may already have been billed, for this one
  // clip, not for the series around it.
  const submitted = withRecord(
    stage,
    artifact.key,
    newRecord({
      inputs: artifact.inputs,
      instruction: call.instruction ?? null,
      outputs: [],
      producer,
      runId,
      status: "submitted",
    })
  );

  await write(artifact.stagePath, serialize(submitted));

  const transport = await submitVideo({
    apiKey: call.apiKey,
    body: order.body,
    fetch: call.fetch,
    url: order.endpoint,
  });

  // Nothing reached the provider, so there is nothing to archive.
  if (!transport.ok) {
    return transport;
  }

  await writeNew(run.transport, serialize(transport.data));

  const refused = httpFailure(transport.data);

  if (refused !== null) {
    return err(refused);
  }

  const jobId = wire.readSubmit(transport.data.body);

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
      instruction: call.instruction ?? null,
      jobId: jobId.data,
      outputs: [],
      producer,
      runId,
      status: "submitted",
    })
  );

  await write(artifact.stagePath, serialize(started));

  const finished = await awaitJob(call, wire, artifact, run, jobId.data);

  if (!finished.ok) {
    return finished;
  }

  if ("failed" in finished.data) {
    return err(
      artifact.blocked([
        `${artifact.key}: ${finished.data.failed}`,
        "nie zostało wyrenderowane ani rozliczone, powtórz polecenie, --regenerate nie jest potrzebne",
      ])
    );
  }

  return await publish(call, wire, artifact, started, {
    instruction: call.instruction ?? null,
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
 * failure, "the job failed" is advice nobody can follow.
 */
type Ending = { readonly failed: string } | { readonly done: Succeeded };

/**
 * Waits for one job, asking at a steady interval.
 *
 * `null` means the provider abandoned the job: not rendered, not billed, and
 * therefore safe to start again. A timeout is not an error either in any sense
 * that costs money, the record keeps its job id, so the next run of the same
 * command picks the clip up where this one left it.
 */
async function awaitJob(
  call: JobCall,
  wire: JobWire,
  artifact: JobArtifact,
  run: VideoRunPaths,
  jobId: string
): Promise<Result<Ending>> {
  const wait = call.wait ?? sleep;
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: polling is the sequence
    const transport = await pollVideo({
      apiKey: call.apiKey,
      fetch: call.fetch,
      url: wire.pollUrl(jobId),
    });

    if (!transport.ok) {
      return transport;
    }

    const refused = httpFailure(transport.data);

    if (refused !== null) {
      return err(refused);
    }

    const task = wire.readTask(transport.data.body);

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
          "jest już opłacone i zapisane, powtórz to samo polecenie, żeby je odebrać; --regenerate kupiłoby drugie",
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
  artifact: JobArtifact,
  data: { readonly model: string; readonly order: Order; readonly runId: string }
): Promise<Result<true>> {
  const prompt =
    data.order.prompt === null ? ok(true) : await writeNew(run.prompt, data.order.prompt);

  if (!prompt.ok) {
    return prompt;
  }

  const request = await writeNew(run.request, serialize(data.order.archive));

  if (!request.ok) {
    return request;
  }

  // The inputs are referenced, never copied.
  return await writeNew(
    run.run,
    serialize({
      artifact: artifact.key,
      endpoint: data.order.endpoint,
      inputs: artifact.inputs,
      model: data.model,
      promptVersion: artifact.promptVersion,
      runId: data.runId,
      seconds: artifact.seconds,
      stage: artifact.stage,
      startedAt: nowIso(),
      status: "submitted",
    })
  );
}

/**
 * The clip's bytes, from the archive when they are already there, and the
 * still the provider handed back beside it, if it handed one back. A still that
 * is cut out of the clip instead is not collected here: that waits until the
 * clip has passed for an MP4.
 */
async function collect(
  call: JobCall,
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

/**
 * The frame the clip ends on, cut out of the clip this attempt downloaded.
 *
 * It is written into the archive under the name the provider's own still would
 * have had, so a resume and a republication find it exactly as they would find
 * a returned one, and it happens before the frame's verdict, so the bytes a
 * human accepts are the bytes that were judged. It happens *after* the clip's
 * verdict, though: the download is a provider's, and a local parser is not
 * where those bytes are first looked at. A failure leaves the record
 * resumable: the clip is bought and archived, and cutting again costs nothing.
 */
async function cut(
  call: JobCall,
  artifact: JobArtifact,
  run: VideoRunPaths
): Promise<Result<Buffer>> {
  if (call.mux === undefined) {
    return err(
      artifact.blocked([`${artifact.key}: nie wskazano silnika, który wytnie ostatnią klatkę`])
    );
  }

  const made = await call.mux.lastFrame({ target: run.endFramePng, video: run.video });
  const frame = made.ok ? await readDigest(run.endFramePng) : null;

  if (frame?.ok === true) {
    return ok(frame.data.bytes);
  }

  return err(
    artifact.blocked([
      `${artifact.key}: nie udało się wyciąć ostatniej klatki z klipu: ${made.ok ? "ffmpeg nie zapisał pliku" : made.error.message}`,
      `klip jest opłacony i zachowany w ${toWorkspacePath(call.workspace.root, run.root)}; powtórz polecenie, --regenerate nie jest potrzebne`,
    ])
  );
}

async function publish(
  call: JobCall,
  wire: JobWire,
  artifact: JobArtifact,
  stage: StageFile,
  data: {
    readonly instruction: string | null;
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

  const verdict = artifact.verdict(collected.data.video);

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
      new AnswerFormatError(
        verdict.error.message,
        toWorkspacePath(call.workspace.root, data.run.root)
      )
    );
  }

  // The end frame is judged against the clip it was taken from, because that is
  // the only size it can honestly be compared to: the provider chose the pixels
  // inside its resolution tier, and the frame is that same picture. Its format
  // is the provider's too, so the file is named after what it holds rather than
  // re-encoded into the one the rest of the tree happens to use.
  let returned = collected.data.endFrame;

  if (returned === null && wire.endFrame === "cut") {
    const cutOut = await cut(call, artifact, data.run);

    if (!cutOut.ok) {
      return cutOut;
    }

    returned = cutOut.data;
  }

  const still = returned === null ? null : validateEndFrame(returned, verdict.data);
  const target = still?.ok === true ? artifact.endFrameTarget(still.data.format) : null;
  const endFrame = target?.ok === true ? returned : null;
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
      instruction: data.instruction,
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
    note: note(verdict.data, endFrame !== null || wire.endFrame === "none", data.resumed),
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
    : ", bez końcówki: dostawca nie zwrócił ostatniej klatki, więc klip kontynuujący nie ma z czego wyjść";

  return `${prefix}${verdict.width}x${verdict.height}, ${verdict.seconds}s${frame}`;
}
