import {
  type ChangeEvent,
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import { buy, commandLine, type Preview } from "../src/ui/commands.js";
import type { PaidReport, RunDone, TextStatus } from "./types";

/**
 * What every stage panel repeats, in one place, so eleven of them cannot drift.
 *
 * This file holds no stage: it holds the arrangement each of them puts its own
 * words into. A button with its command underneath, a field whose value is
 * whatever somebody typed, the whole text a command printed, and the bytes of
 * an artifact addressed by what it is. That is the same promotion rule
 * `src/lib` follows: the piece two panels copy moves here rather than being
 * written twice, because three copies make an arrangement into a coincidence.
 *
 * The one rule none of it may break: **nothing here reads a state or computes
 * a verdict.** A panel renders what `status`, `check` and the artifact
 * resolver already said. The moment a component in this file decides whether
 * something is ready, the screen has learned something the terminal does not
 * know, which is the second road this whole module exists not to build.
 */

function Command(props: { readonly argv: readonly string[] }): JSX.Element {
  return <code className="command">{commandLine(props.argv)}</code>;
}

/**
 * One action, and the command it runs standing underneath it.
 *
 * The two are one array rather than two, which is the whole point: a person
 * reading this screen can paste what the button does and get what it did, and
 * an agent driving the same pipeline reads the same words.
 */
export function Action(props: {
  readonly argv: readonly string[];
  readonly disabled: boolean;
  readonly label: string;
  readonly onRun: (argv: readonly string[]) => void;
  /** The one cyan button of a group; everything else is a plain action. */
  readonly primary?: boolean;
}): JSX.Element {
  const { argv, disabled, label, onRun, primary = false } = props;
  const start = useCallback(() => onRun(argv), [argv, onRun]);

  return (
    <div className="actions">
      <button
        className={primary ? "action action-primary" : "action"}
        disabled={disabled}
        onClick={start}
        type="button"
      >
        {label}
      </button>
      <Command argv={argv} />
    </div>
  );
}

/**
 * A labelled text field whose value is a string and stays one.
 *
 * Even the two settings that are numbers, because an empty field means
 * undecided and coercing it to zero would be the browser answering a question
 * rule 7 reserves for a person.
 */
export function Field(props: {
  readonly id: string;
  readonly label: string;
  readonly onValue: (value: string) => void;
  readonly placeholder?: string;
  readonly value: string;
}): JSX.Element {
  const { id, label, onValue, placeholder, value } = props;
  const change = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onValue(event.target.value),
    [onValue]
  );

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} onChange={change} placeholder={placeholder} type="text" value={value} />
    </div>
  );
}

/** What a stage refuses over, in the stage's own sentences. */
export function Problems(props: { readonly problems: readonly string[] }): JSX.Element[] {
  return props.problems.map((problem) => (
    <p className="problem" key={problem}>
      {problem}
    </p>
  ));
}

/** The last command's whole answer, in the words the terminal would print. */
export function RunOutput(props: {
  readonly run: RunDone | null;
  readonly running: boolean;
}): JSX.Element {
  const { run, running } = props;

  return (
    <>
      {running ? <p className="run-pending">Komenda w toku…</p> : null}
      {run === null ? null : (
        <pre className={run.ok ? "run-output" : "run-output run-refused"}>
          {run.ok ? run.data : run.error.message}
        </pre>
      )}
    </>
  );
}

/**
 * Polish counts in three forms, and a bill that gets them wrong reads as a bug.
 *
 * It sits here rather than in a panel because the bill is the one number every
 * paid stage has to put on screen correctly, and the stages that draw six
 * images need the third form that a stage buying one call never reaches.
 */
function plural(count: number, forms: readonly [string, string, string]): string {
  const tens = count % 100;
  const ones = count % 10;

  if (count === 1) {
    return `${count} ${forms[0]}`;
  }

  const few = ones >= 2 && ones <= 4 && !(tens >= 12 && tens <= 14);

  return `${count} ${few ? forms[1] : forms[2]}`;
}

/** The unit a stage is billed in, in the three forms Polish counts in. */
export type Unit = readonly [string, string, string];

const CALLS: Unit = ["płatne wywołanie", "płatne wywołania", "płatnych wywołań"];

/** What a text stage's paid command is told, beyond which episode it is about. */
export interface SendFlags {
  readonly model: string;
  readonly regenerate: boolean;
  readonly tokens: string;
}

export const NO_FLAGS: SendFlags = { model: "", regenerate: false, tokens: "" };

/**
 * The three flags every paid text stage takes, and nothing about any of them.
 *
 * An empty field is not a value: the flag is then not spelled at all and the
 * CLI's own answer stands, which for the model is that stage's environment
 * variable and for the budget is the command's default. Rule 7 at the edge of
 * the screen, where a blank box must not become a zero.
 */
export function SendFields(props: {
  readonly id: string;
  readonly modelPlaceholder: string;
  readonly onChange: (flags: SendFlags) => void;
  readonly tokensPlaceholder: string;
  readonly value: SendFlags;
}): JSX.Element {
  const { id, onChange, value } = props;
  const changeModel = useCallback(
    (model: string) => onChange({ ...value, model }),
    [onChange, value]
  );
  const changeTokens = useCallback(
    (tokens: string) => onChange({ ...value, tokens }),
    [onChange, value]
  );
  const changeRegenerate = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onChange({ ...value, regenerate: event.target.checked }),
    [onChange, value]
  );

  return (
    <div className="send">
      <Field
        id={`${id}-model`}
        label="Model"
        onValue={changeModel}
        placeholder={props.modelPlaceholder}
        value={value.model}
      />
      <Field
        id={`${id}-tokens`}
        label="Limit tokenów"
        onValue={changeTokens}
        placeholder={props.tokensPlaceholder}
        value={value.tokens}
      />
      <label className="field-check" htmlFor={`${id}-regenerate`}>
        <input
          checked={value.regenerate}
          id={`${id}-regenerate`}
          onChange={changeRegenerate}
          type="checkbox"
        />
        Nowa płatna próba, zachowując poprzednią
      </label>
    </div>
  );
}

/** A dry run that came back, beside the object it came back with. */
interface Previewed {
  readonly report: PaidReport;
  readonly send: Preview;
}

/**
 * The one dangerous button on this screen, and the step that has to precede it.
 *
 * It is here rather than in a stage's panel because the two steps are one
 * piece of behaviour repeated by every paid stage, and three copies of it
 * would make "two steps, always" a thing to remember. The preview it holds is
 * derived from what the panel last sent and what came back under that run's
 * identifier, never from a flag set on the way out, because the answer arrives
 * on a stream the panel shares with the ladder and with the terminal.
 *
 * Anything the panel starts afterwards takes "Kup" away again, including a
 * second dry run while the first is still in flight: two steps are only two if
 * the second one is about the first.
 */
export function PaidCall(props: {
  /** The stage's own flags, which decide what the preview argv says. */
  readonly children: ReactNode;
  readonly note: string;
  readonly onRun: (argv: readonly string[]) => void;
  readonly preview: readonly string[];
  readonly projectRun: RunDone | null;
  readonly running: boolean;
  /** The argv of the last command the panel started, whatever it was. */
  readonly sent: readonly string[] | null;
  /**
   * What this stage's bill counts, when calls is the wrong word for it.
   *
   * On an image stage one call is one picture, and pictures are what a person
   * is deciding about, so the number says images. The PRD's rule is that the
   * bill stands in a unit the CLI already counts, not that every stage counts
   * the same thing.
   */
  readonly unit?: Unit;
}): JSX.Element {
  const { children, note, onRun, preview, projectRun, running, sent, unit = CALLS } = props;
  const [previewed, setPreviewed] = useState<Previewed | null>(null);

  useEffect(() => {
    if (sent === null || !(sent.includes("--dry-run") && projectRun?.ok === true)) {
      setPreviewed(null);

      return;
    }

    try {
      setPreviewed({
        report: JSON.parse(projectRun.data) as PaidReport,
        send: { argv: sent, runId: projectRun.runId },
      });
    } catch {
      setPreviewed(null);
    }
  }, [projectRun, sent]);

  const runBuy = useCallback(() => {
    if (previewed !== null) {
      onRun(buy(previewed.send));
    }
  }, [onRun, previewed]);

  return (
    <>
      <h3>Płatne wywołanie</h3>
      <p className="actions-note">{note}</p>
      {children}

      <Action argv={preview} disabled={running} label="Generuj" onRun={onRun} />

      {previewed === null ? (
        <p className="actions-note">
          „Kup” pojawia się dopiero po podglądzie, zawsze, także gdy wywołanie jest jedno. Bez niego
          nic nie wychodzi do modelu.
        </p>
      ) : (
        <Bought onBuy={runBuy} previewed={previewed} running={running} unit={unit} />
      )}
    </>
  );
}

/** What a finished dry run says, and the button it may or may not unlock. */
function Bought(props: {
  readonly onBuy: () => void;
  readonly previewed: Previewed;
  readonly running: boolean;
  readonly unit: Unit;
}): JSX.Element {
  const { report, send } = props.previewed;

  return (
    <>
      <p className="bill">Do kupienia: {plural(report.paidCalls, props.unit)}</p>

      <Problems problems={report.problems} />

      {report.paidCalls === 0 ? null : (
        <div className="actions">
          <button
            className="action action-primary"
            disabled={props.running}
            onClick={props.onBuy}
            type="button"
          >
            Kup
          </button>
          <Command argv={buy(send)} />
        </div>
      )}

      {report.prompt === null ? null : (
        <>
          <h3>Prompt, który poleci do modelu</h3>
          <pre className="artifact-text">{report.prompt}</pre>
        </>
      )}
    </>
  );
}

/**
 * Inputs whose bytes no longer match what this stage was written from.
 *
 * Drift is reported and never recorded, exactly as `check` reports it: the
 * file is intact and the consent to it has lapsed, which is a different thing
 * from a broken artifact and has to read differently on screen.
 */
export function Drift(props: { readonly paths: readonly string[]; readonly title: string }) {
  return props.paths.length === 0 ? null : (
    <div className="drift" role="alert">
      <p className="drift-title">{props.title}</p>
      <ul>
        {props.paths.map((path) => (
          <li key={path}>
            <code>{path}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The two commands every reviewed stage has, under the CLI's own condition.
 *
 * "Zatwierdź" appears only where `check` reports a file that validates, that
 * nobody has accepted yet, and nothing to fix first. That is the same test the
 * CLI applies before it records anything, said once here rather than three
 * times: a button the terminal would refuse teaches a person the screen lies.
 */
export function Review(props: {
  readonly approve: readonly string[];
  readonly check: readonly string[];
  readonly note: string;
  readonly onRun: (argv: readonly string[]) => void;
  readonly running: boolean;
  readonly status: TextStatus | null;
}): JSX.Element {
  const { approve, check, note, onRun, running, status } = props;
  const acceptable =
    status !== null &&
    status.status === "completed" &&
    !status.approved &&
    status.problems.length === 0;

  return (
    <>
      <Action argv={check} disabled={running} label="Sprawdź" onRun={onRun} />
      {acceptable ? (
        <Action argv={approve} disabled={running} label="Zatwierdź" onRun={onRun} primary />
      ) : (
        <p className="actions-note">{note}</p>
      )}
    </>
  );
}

/**
 * What the resolver is asked for: what an artifact is, never where it lives.
 *
 * The three optional fields are the axes a stage may or may not have. They
 * travel beside the path rather than in it, because a character's card is
 * under no episode and a screenplay is under no track.
 */
interface ArtifactRef {
  readonly artifact: string;
  readonly characterId?: string;
  readonly episodeId?: string;
  readonly projectId: string;
  readonly stage: string;
  readonly track?: string;
}

export function artifactUrl(one: ArtifactRef): string {
  const axes = new URLSearchParams();

  for (const [name, value] of [
    ["character", one.characterId],
    ["episode", one.episodeId],
    ["track", one.track],
  ] as const) {
    if (value !== undefined && value !== "") {
      axes.set(name, value);
    }
  }

  const query = axes.toString();

  return `/api/artifact/${one.projectId}/${one.stage}/${one.artifact}${query === "" ? "" : `?${query}`}`;
}

/**
 * An artifact's bytes as text, re-read whenever the stage says it moved.
 *
 * `revision` is whatever the caller has that changes when the file might have:
 * the cell's state, usually. Nothing here polls, because the ladder already
 * arrives on a stream and a second clock would only disagree with it.
 */
export function useArtifactText(one: ArtifactRef, revision: string): string | null {
  const [text, setText] = useState<string | null>(null);
  const url = artifactUrl(one);

  useEffect(() => {
    let cancelled = false;

    fetch(url)
      .then(async (response) => (response.ok ? await response.text() : null))
      .then((body) => {
        if (!cancelled) {
          setText(body);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setText(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [revision, url]);

  return text;
}
