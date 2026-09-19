import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { err, ok, type Result } from "../result.js";

/**
 * Internal to the assembly module: the local engine, and nothing else.
 *
 * It is injected the way `fetch` is injected into a paid stage, and for the
 * same reason — every rule around the cut has to be testable without running
 * the program. What it hides is the whole of what this repository knows about
 * ffmpeg: where it is, which version answered, how a concatenation is spelled,
 * and how to tell a refusal from a crash.
 *
 * **The clips are copied, never re-encoded.** Both tracks render at one
 * resolution and one frame rate from one video model, so the concat demuxer's
 * precondition genuinely holds — and a re-encode would put pixels into the film
 * that nobody accepted, which is the same thing rule 6 and the bytes-bound
 * approval forbid a step above. Where the precondition does not hold, this
 * refuses; it never quietly switches to re-encoding.
 *
 * **There is no fallback.** A muxer written in this repository would be a
 * container writer it would then have to trust, which is exactly what stage 7
 * avoided by reading boxes instead of shelling out to a decoder. So a missing
 * ffmpeg is a refusal that names the remedy, and it costs nothing because
 * nothing here was ever bought.
 */

/** Long enough for a feature-length copy, short enough to not hang a terminal. */
const TIMEOUT_MS = 10 * 60_000;
/**
 * Room for everything the engine says, with margin.
 *
 * `execFile` kills the process when this is exceeded, which on a run that had
 * already written the file would turn a success into a reported failure. The
 * engine is also asked for `-loglevel warning`, so what lands here is what it
 * complained about rather than a progress counter — which is what the archive
 * is for, and what keeps a long episode from ever approaching the limit.
 */
const MAX_OUTPUT = 4 * 1024 * 1024;
const VERSION = /^ffmpeg version (\S+)/;

export interface ConcatInput {
  /** Absolute paths, in the order the approved plan cuts them. */
  readonly clips: readonly string[];
  /** Where the list of inputs is written, so the archive holds what actually ran. */
  readonly listPath: string;
  readonly target: string;
}

export interface ConcatReport {
  /** The exact invocation, for the archive. It carries no secret: there is none. */
  readonly argv: readonly string[];
  /** The engine's name and version — what `producer.model` records. */
  readonly engine: string;
  readonly stderr: string;
}

/**
 * The narrow half of this module: ask what the engine is, or ask it to cut.
 *
 * `version` exists apart from `concat` because `--dry-run` has to answer "would
 * this work" without writing anything, and because a missing engine is an
 * obstacle a person reads beside the gate rather than a failure they discover
 * after the lock is taken.
 */
export interface Muxer {
  readonly concat: (input: ConcatInput) => Promise<Result<ConcatReport>>;
  readonly version: () => Promise<Result<string>>;
}

class MuxError extends Error {
  readonly reason: "absent" | "failed" | "incompatible";

  constructor(reason: MuxError["reason"], message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = "MuxError";
    this.reason = reason;
  }
}

interface ProcessResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

/** The engine as found on this machine. `binary` is a name on PATH or a path. */
export function ffmpeg(binary: string): Muxer {
  return {
    concat: (input) => concat(binary, input),
    version: () => version(binary),
  };
}

async function version(binary: string): Promise<Result<string>> {
  const run = await spawn(binary, ["-hide_banner", "-version"]);

  if (!run.ok) {
    return run;
  }

  const found = VERSION.exec(run.data.stdout.trim());

  return found === null
    ? err(
        new MuxError(
          "incompatible",
          `"${binary}" odpowiedział, ale nie przedstawił się jako ffmpeg — montaż potrzebuje ffmpeg`
        )
      )
    : ok(`ffmpeg ${found[1]}`);
}

async function concat(binary: string, input: ConcatInput): Promise<Result<ConcatReport>> {
  const engine = await version(binary);

  if (!engine.ok) {
    return engine;
  }

  const listed = await writeList(input);

  if (!listed.ok) {
    return listed;
  }

  const args = [
    "-hide_banner",
    "-nostdin",
    // What the archive keeps is what the engine complained about, not a
    // progress counter it redraws a thousand times.
    "-loglevel",
    "warning",
    // The concat demuxer rather than the concat filter: the filter decodes and
    // re-encodes, and these bytes were accepted as they are.
    "-f",
    "concat",
    // The list holds absolute paths, which the demuxer refuses by default.
    "-safe",
    "0",
    "-i",
    input.listPath,
    "-c",
    "copy",
    // The index up front, so the file plays before it has finished downloading
    // wherever it ends up. It rewrites no frame.
    "-movflags",
    "+faststart",
    "-y",
    input.target,
  ];
  const run = await spawn(binary, args);

  if (!run.ok) {
    return run;
  }

  return run.data.code === 0
    ? ok({ argv: [binary, ...args], engine: engine.data, stderr: run.data.stderr })
    : err(
        new MuxError(
          "failed",
          `ffmpeg zakończył się kodem ${run.data.code} i nie skleił odcinka:\n${run.data.stderr.trim()}`
        )
      );
}

/**
 * The concat list, in the demuxer's own format.
 *
 * It is written into the run archive rather than into a temporary file, because
 * it is the one description of what this cut actually was — and an archive that
 * held the arguments but not the list would record half the invocation.
 */
async function writeList(input: ConcatInput): Promise<Result<true>> {
  const body = input.clips.map((path) => `file '${path.replaceAll("'", "'\\''")}'\n`).join("");

  try {
    await mkdir(dirOf(input.listPath), { recursive: true });
    await writeFile(input.listPath, body, "utf8");

    return ok(true);
  } catch (cause) {
    return err(
      new MuxError("failed", `nie można zapisać listy montażowej ${input.listPath}`, { cause })
    );
  }
}

function dirOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

/**
 * Runs the program and reports what it said.
 *
 * A non-zero exit is data, not an exception: ffmpeg refuses loudly and the
 * refusal is what a person needs to read. Only a program that could not be
 * started at all is an error of its own, because that is the one case with a
 * different remedy — install it, or point `AIMATOR_FFMPEG` at it.
 */
function spawn(binary: string, args: readonly string[]): Promise<Result<ProcessResult>> {
  return new Promise((resolve) => {
    execFile(
      binary,
      [...args],
      { maxBuffer: MAX_OUTPUT, timeout: TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => {
        const failure = error as (Error & { code?: number | string }) | null;

        if (failure !== null && (failure.code === "ENOENT" || failure.code === "EACCES")) {
          resolve(
            err(
              new MuxError(
                "absent",
                `nie znaleziono ffmpeg ("${binary}") — zainstaluj go albo wskaż ścieżkę przez AIMATOR_FFMPEG; etap 8 nie ma drugiej drogi i niczego nie przekoduje`,
                { cause: error }
              )
            )
          );

          return;
        }

        resolve(ok({ code: exitCodeOf(failure), stderr, stdout }));
      }
    );
  });
}

/**
 * The exit code, as a number.
 *
 * `execFile` reports a signal or a timeout without a numeric code, so a failure
 * that carries no number still has to read as a failure — `1` rather than the
 * `0` a missing field would otherwise be mistaken for.
 */
function exitCodeOf(failure: (Error & { code?: number | string }) | null): number {
  if (failure === null) {
    return 0;
  }

  return typeof failure.code === "number" ? failure.code : 1;
}
