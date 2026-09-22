import {
  type ChangeEvent,
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import { buy, commandLine, type Preview } from "../src/ui/commands.js";
import type { CallsReport, Drawn, DrawnReport, PaidReport, RunDone, TextStatus } from "./types";

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
/** An image stage's bill counts pictures, because pictures are the decision. */
const IMAGES: Unit = ["obraz", "obrazy", "obrazów"];

/** One line of a bill: how many of one thing, in that thing's own word. */
export interface Billed {
  readonly count: number;
  readonly unit: Unit;
}

/**
 * What a dry run costs and what it would send, in the stage's own fields.
 *
 * Both halves are a **reading** rather than a format: the report is the object
 * the CLI already prints, and a panel says which of its fields are the bill
 * and which are the text. That is why this is a function each stage brings and
 * not a shape every stage is bent into. Stage 7 is billed in two currencies
 * and buys several prompts at once; stage 1 is billed in one and sends one.
 */
export interface Priced {
  /** Never summed: two media on one bill are two numbers a person reads. */
  readonly billed: readonly Billed[];
  readonly prompts: readonly { readonly label: string; readonly text: string }[];
}

/** A text stage's reading: one call, one prompt, both at the top of the report. */
export function asCalls(report: CallsReport): Priced {
  return {
    billed: [{ count: report.paidCalls, unit: CALLS }],
    prompts:
      report.prompt === null
        ? []
        : [{ label: "Prompt, który poleci do modelu", text: report.prompt }],
  };
}

/** An image stage's: the bill counts pictures, and each picture has its own text. */
export function asImages(report: DrawnReport): Priced {
  return {
    billed: [{ count: report.paidCalls, unit: IMAGES }],
    prompts: promptsOf(report.artifacts),
  };
}

/** Every artifact this call would send a text to, under the id it belongs to. */
export function promptsOf(
  artifacts: readonly { readonly id: string; readonly prompt: string | null }[]
): readonly { readonly label: string; readonly text: string }[] {
  return artifacts.flatMap((one) =>
    one.prompt === null ? [] : [{ label: `Prompt ${one.id}`, text: one.prompt }]
  );
}

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

/** A dry run that came back, beside the reading the stage made of it. */
interface Previewed {
  readonly priced: Priced;
  readonly problems: readonly string[];
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
export function PaidCall<Report extends PaidReport>(props: {
  /** The stage's own flags, which decide what the preview argv says. */
  readonly children: ReactNode;
  readonly note: string;
  readonly onRun: (argv: readonly string[]) => void;
  readonly preview: readonly string[];
  readonly projectRun: RunDone | null;
  /**
   * How this stage reads its own report: which fields are the bill, and which
   * are the text that would be sent.
   *
   * It is a prop rather than a shape because the PRD's rule is that the bill
   * stands in a unit **the CLI already counts**, not that every stage counts
   * the same thing. One call is one picture on an image stage, and on stage 7
   * it is either a frame or a clip, which cost differently by an order of
   * magnitude and are therefore two numbers rather than one.
   */
  readonly read: (report: Report) => Priced;
  readonly running: boolean;
  /** The argv of the last command the panel started, whatever it was. */
  readonly sent: readonly string[] | null;
}): JSX.Element {
  const { children, note, onRun, preview, projectRun, read, running, sent } = props;
  const [previewed, setPreviewed] = useState<Previewed | null>(null);

  useEffect(() => {
    if (sent === null || !(sent.includes("--dry-run") && projectRun?.ok === true)) {
      setPreviewed(null);

      return;
    }

    try {
      const report = JSON.parse(projectRun.data) as Report;

      setPreviewed({
        priced: read(report),
        problems: report.problems,
        send: { argv: sent, runId: projectRun.runId },
      });
    } catch {
      setPreviewed(null);
    }
  }, [projectRun, read, sent]);

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
        <Bought onBuy={runBuy} previewed={previewed} running={running} />
      )}
    </>
  );
}

/**
 * What a finished dry run says, and the button it may or may not unlock.
 *
 * The bill is printed line by line and never summed. Two media on one bill are
 * two decisions about two prices, so one total would be a number nobody is
 * billed; what decides whether anything can be bought is whether **any** line
 * is more than zero, which is the same question the CLI answers by refusing.
 */
function Bought(props: {
  readonly onBuy: () => void;
  readonly previewed: Previewed;
  readonly running: boolean;
}): JSX.Element {
  const { priced, problems, send } = props.previewed;
  const buying = priced.billed.some((line) => line.count > 0);

  return (
    <>
      <p className="bill">
        Do kupienia: {priced.billed.map((line) => plural(line.count, line.unit)).join(", ")}
      </p>

      <Problems problems={problems} />

      {buying ? (
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
      ) : null}

      {priced.prompts.map((prompt) => (
        <div key={prompt.label}>
          <h3>{prompt.label}</h3>
          <pre className="artifact-text">{prompt.text}</pre>
        </div>
      ))}
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
  // Encoded rather than spelled: stage 7's entry frames are `entry:C02`, which
  // is the id the CLI's own `--artifact` takes, and an id a panel had to
  // rewrite before it could ask for it would be a second naming scheme.
  const artifact = encodeURIComponent(one.artifact);

  return `/api/artifact/${one.projectId}/${one.stage}/${artifact}${query === "" ? "" : `?${query}`}`;
}

/** What the state of one picture means, in the word a person reads. */
const DRAWN_STATE: Record<Drawn["state"], string> = {
  absent: "jeszcze nie narysowany",
  completed: "narysowany, czeka na ocenę",
  submitted: "próba przerwana",
};

/**
 * The pictures of one stage on one track, each beside the box that picks it.
 *
 * It is here rather than in a stage's panel because three stages draw and the
 * arrangement is the same for all of them: the image, its state in the stage's
 * own words, and, where the CLI accepts a list, a checkbox. Stage 6 passes no
 * `onToggle`, which is how "one artifact, so nothing to narrow" is said on
 * screen: no boxes appear, because there is no choice to make.
 */
export function Gallery(props: {
  readonly chosen: readonly string[];
  /** Keeps the checkbox ids unique when two galleries share a page. */
  readonly idPrefix: string;
  readonly items: readonly Drawn[];
  readonly onToggle: ((id: string, wanted: boolean) => void) | null;
  readonly urlOf: (id: string) => string;
}): JSX.Element {
  const { chosen, idPrefix, items, onToggle, urlOf } = props;

  return (
    <ul className="pictures">
      {items.map((item) => (
        <Shown
          chosen={chosen.includes(item.id)}
          idPrefix={idPrefix}
          item={item}
          key={item.id}
          onToggle={onToggle}
          url={urlOf(item.id)}
        />
      ))}
    </ul>
  );
}

function Shown(props: {
  readonly chosen: boolean;
  readonly idPrefix: string;
  readonly item: Drawn;
  readonly onToggle: ((id: string, wanted: boolean) => void) | null;
  readonly url: string;
}): JSX.Element {
  const { chosen, idPrefix, item, onToggle, url } = props;
  const boxId = `${idPrefix}-${item.id}`;
  const toggle = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onToggle?.(item.id, event.target.checked),
    [item.id, onToggle]
  );

  return (
    <li className="picture">
      {onToggle === null ? (
        <p className="picture-name">
          <code>{item.id}</code>
        </p>
      ) : (
        <label className="field-check" htmlFor={boxId}>
          <input checked={chosen} id={boxId} onChange={toggle} type="checkbox" />
          <code>{item.id}</code>
        </label>
      )}
      {item.verdict === null ? (
        <p className="picture-empty">{DRAWN_STATE[item.state]}</p>
      ) : (
        <img
          alt={item.id}
          height={item.verdict.height}
          loading="lazy"
          src={url}
          width={item.verdict.width}
        />
      )}
      <p className="picture-state">
        {item.approved ? "zatwierdzony" : DRAWN_STATE[item.state]} · {item.note}
      </p>
    </li>
  );
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
