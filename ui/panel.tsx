import {
  type ChangeEvent,
  createContext,
  type JSX,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { buy, commandLine, type Preview } from "../src/ui/commands.js";
import type {
  CallsReport,
  Drawn,
  DrawnPrompt,
  DrawnReport,
  PaidReport,
  RunDone,
  TextStatus,
} from "./types";

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

const COMMANDS_KEY = "aimator-commands";

/** Whether this viewer asked to see commands; a browser that will not say is a no. */
function commandsWanted(): boolean {
  try {
    return window.localStorage.getItem(COMMANDS_KEY) === "shown";
  } catch {
    return false;
  }
}

/**
 * The command under every button, shown when somebody asks for it.
 *
 * Every button still runs exactly one argv and every argv is still on the
 * page: this only decides whether it stands beside the button. Twelve boxed
 * command lines on one stage made the buttons hard to find, and whoever drives
 * the pipeline from a terminal turns them on once and keeps them, which is why
 * the choice is remembered in this browser and nowhere else.
 */
export function Commands(props: { readonly children: ReactNode }): JSX.Element {
  const [shown, setShown] = useState(commandsWanted);
  const change = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const wanted = event.target.checked;

    setShown(wanted);

    try {
      window.localStorage.setItem(COMMANDS_KEY, wanted ? "shown" : "hidden");
    } catch {
      // A private window keeps the choice for this page only, which is enough.
    }
  }, []);

  return (
    <div className={shown ? "commands" : "commands commands-hidden"}>
      <label className="field-check commands-toggle" htmlFor="commands-toggle">
        <input checked={shown} id="commands-toggle" onChange={change} type="checkbox" />
        Pokaż polecenia CLI pod przyciskami
      </label>
      {props.children}
    </div>
  );
}

/**
 * Why a block works the way it does, folded under one line.
 *
 * The reasons are the documentation of a decision and stay on the page, but
 * a person who has read them once should not have to read past them again.
 */
function Hint(props: { readonly children: ReactNode }): JSX.Element {
  return (
    <details className="hint">
      <summary>Jak to działa</summary>
      <div className="hint-body">{props.children}</div>
    </details>
  );
}

/**
 * Whether the stage on screen already has its yes.
 *
 * A settled stage is visited to look something up, not to work on it, so its
 * blocks start folded and the page reads as a list of titles. It is a context
 * rather than a prop because every block of every panel asks the same
 * question about the same cell, and threading it through thirteen panels
 * would be thirteen copies of one fact.
 */
const Settled = createContext(false);

export function SettledStage(props: {
  readonly children: ReactNode;
  readonly settled: boolean;
}): JSX.Element {
  return <Settled.Provider value={props.settled}>{props.children}</Settled.Provider>;
}

/**
 * One part of a panel, as a card of its own that folds.
 *
 * Every stage is read in the same order: where it stands, what it produced,
 * the decision about it, and what it would cost to make again. Each of those
 * is a block, so a panel reads as four answers rather than one wall, and each
 * folds under its title. `fold` is whether it starts open, for the blocks that
 * are the rarer question (buying again, the settings); every block starts
 * folded on a stage that is already approved. It is read once: a block that
 * closed itself while somebody was inside it would be the screen taking
 * something away mid-sentence.
 */
export function Block(props: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly fold?: boolean;
  readonly hint?: ReactNode;
  readonly title: string;
}): JSX.Element {
  const { children, className, fold = true, hint, title } = props;
  const settled = useContext(Settled);
  const [startsOpen] = useState(fold && !settled);
  const classes = className === undefined ? "block" : `block ${className}`;

  return (
    <details className={classes} open={startsOpen}>
      <summary>
        <h3>{title}</h3>
      </summary>
      <div className="block-body">
        {hint === undefined ? null : <Hint>{hint}</Hint>}
        {children}
      </div>
    </details>
  );
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

/** How many refusals stand open before the rest fold away. */
const PROBLEMS_SHOWN = 2;

function problemLines(problems: readonly string[]): JSX.Element[] {
  return problems.map((problem) => (
    <p className="problem" key={problem}>
      {problem}
    </p>
  ));
}

/**
 * What a stage refuses over, in the stage's own sentences.
 *
 * Every sentence stays on the page, but past the first two they fold: one
 * changed input lapses the consent of every artifact drawn from it, so a
 * stage can refuse over a dozen files in one breath, and a dozen warnings
 * above the gallery push the thing being judged off the screen. The count is
 * on the fold, so nothing is hidden without saying how much.
 */
export function Problems(props: { readonly problems: readonly string[] }): JSX.Element | null {
  const { problems } = props;

  if (problems.length === 0) {
    return null;
  }

  // One more than the fold would hide is not worth a fold.
  if (problems.length <= PROBLEMS_SHOWN + 1) {
    return <div className="problems">{problemLines(problems)}</div>;
  }

  const rest = problems.slice(PROBLEMS_SHOWN);

  return (
    <div className="problems">
      {problemLines(problems.slice(0, PROBLEMS_SHOWN))}
      <details className="problems-more">
        <summary>Pokaż pozostałe powody ({rest.length})</summary>
        {problemLines(rest)}
      </details>
    </div>
  );
}

/**
 * What a stage says **without** refusing, which is a different thing entirely.
 *
 * The split is load-bearing rather than cosmetic and the contract says so: a
 * stage puts every reason it would refuse in `problems`, and everything it
 * says while carrying on in `notices`. Stage 8's silent cut is the first one
 * on this screen, and calling it a problem would paint a finished, accepted
 * film as a blocked cell. It sits beside `Problems` for that reason: the two
 * are one decision about one answer, and splitting them across files is how
 * they would start to look alike.
 */
export function Notices(props: { readonly notices: readonly string[] }): JSX.Element[] {
  return props.notices.map((notice) => (
    <p className="notice" key={notice}>
      {notice}
    </p>
  ));
}

/**
 * The last command of a stage page, where the eye already is.
 *
 * A stage page is long, and an answer printed at the foot of its panel was an
 * answer to a click made a screen higher, out of sight. So it stands at the
 * bottom of the window instead, whatever part of the page started it: a
 * refusal opens itself, because it is the one answer that asks for something,
 * and a success says so in one word and opens on request.
 */
export function RunDock(props: {
  readonly argv: readonly string[] | null;
  readonly run: RunDone | null;
  readonly running: boolean;
}): JSX.Element | null {
  const { argv, run, running } = props;
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const toggle = useCallback(() => setOpen((current) => !current), []);
  const dismiss = useCallback(() => setDismissed(run?.runId ?? null), [run]);

  useEffect(() => {
    setOpen(run !== null && !run.ok);
  }, [run]);

  if (running) {
    return (
      <div aria-live="polite" className="dock dock-running" role="status">
        <div className="dock-bar">
          <span className="dock-state">Komenda w toku…</span>
          {argv === null ? null : <code className="dock-command">{commandLine(argv)}</code>}
        </div>
      </div>
    );
  }

  if (run === null || dismissed === run.runId) {
    return null;
  }

  return (
    <div
      aria-live="polite"
      className={run.ok ? "dock dock-done" : "dock dock-refused"}
      role={run.ok ? "status" : "alert"}
    >
      <div className="dock-bar">
        <span className="dock-state">{run.ok ? "Gotowe" : "Odmowa"}</span>
        {argv === null ? null : <code className="dock-command">{commandLine(argv)}</code>}
        <button className="dock-button" onClick={toggle} type="button">
          {open ? "Ukryj wynik" : "Pokaż wynik"}
        </button>
        <button aria-label="Zamknij wynik" className="dock-button" onClick={dismiss} type="button">
          ×
        </button>
      </div>
      {open ? (
        <pre className={run.ok ? "run-output dock-output" : "run-output run-refused dock-output"}>
          {run.ok ? run.data : run.error.message}
        </pre>
      ) : null}
    </div>
  );
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
export function plural(count: number, forms: readonly [string, string, string]): string {
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
  /**
   * A number that stands **beside** the bill and must never be added into it.
   *
   * Stage 9 is why it exists: the speech provider documents the continuity
   * parameters and does not say whether it charges for their characters. On
   * any ordinary reading of "billed per character converted to audio" they are
   * free, but this tool does not guess with somebody else's account, so the
   * figure is on screen and labelled as the one to add if that turns out wrong.
   */
  readonly aside?: string;
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

/**
 * An image stage's: the bill counts pictures, and each picture has its own text.
 *
 * It reads all three image stages, which is why it reads both the set and the
 * single artifact: stage 6 draws one frame and says so in the singular, for
 * the same reason it takes no `--artifact` anywhere. A reader that knew only
 * the plural did not print stage 6's prompt, it threw, and the two-step buy is
 * built to treat an unreadable preview as no preview, so the whole stage lost
 * its "Kup" without a word on the screen.
 */
export function asImages(report: DrawnReport): Priced {
  const drawn = report.artifacts ?? (report.artifact === undefined ? [] : [report.artifact]);

  return {
    billed: [{ count: report.paidCalls, unit: IMAGES }],
    prompts: promptsOf(drawn),
  };
}

/** Every artifact this call would send a text to, under the name it belongs to. */
export function promptsOf(
  artifacts: readonly DrawnPrompt[]
): readonly { readonly label: string; readonly text: string }[] {
  return artifacts.flatMap((one) =>
    one.prompt === null ? [] : [{ label: `Prompt ${namedBy(one)}`, text: one.prompt }]
  );
}

/** Whichever of the two words the stage that drew this one uses for it. */
function namedBy(one: DrawnPrompt): string {
  return "artifact" in one ? one.artifact : one.id;
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
  /**
   * Whether the block starts open. A stage waiting to be generated opens on
   * it; one with something to review keeps buying folded, since paying again
   * is the rarer question there.
   */
  readonly open: boolean;
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
  const { children, note, onRun, open, preview, projectRun, read, running, sent } = props;
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
    <Block fold={open} hint={note} title="Generowanie (płatne)">
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
    </Block>
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

      {priced.aside === undefined ? null : <p className="actions-note">{priced.aside}</p>}

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

      {/* Folded one by one: a stage that draws ten pictures sends ten texts,
          and the bill above them is what decides whether to buy. */}
      {priced.prompts.map((prompt) => (
        <details className="prompt" key={prompt.label}>
          <summary>{prompt.label}</summary>
          <pre className="artifact-text">{prompt.text}</pre>
        </details>
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
 * Which of the ticked ids a command may carry.
 *
 * An approved item is shown ticked and locked, so it cannot slip into the next
 * "Zatwierdź" by accident; what somebody ticked before it was approved does
 * not survive that either. It is unlocked only where choosing something already
 * accepted is the point: a new paid attempt, or stage 7's republication. The
 * answer is always a subset of what was ticked, so a lock never adds anything
 * to a command.
 */
export function pickable(
  items: readonly { readonly approved: boolean; readonly id: string }[],
  chosen: readonly string[],
  unlocked: boolean
): readonly string[] {
  if (unlocked) {
    return chosen;
  }

  const accepted = new Set(items.filter((item) => item.approved).map((item) => item.id));

  return chosen.filter((id) => !accepted.has(id));
}

/**
 * The box beside one item of a list, and the item's name.
 *
 * Checked and disabled for an approved item while approved items are locked,
 * which says "already accepted" in the one place a person looks for it;
 * otherwise an ordinary choice. The state line under the item still says
 * "zatwierdzony" in words, because a ticked box alone is a colour-free sign
 * that means two things.
 */
export function PickBox(props: {
  readonly approved: boolean;
  readonly boxId: string;
  readonly chosen: boolean;
  readonly id: string;
  readonly onToggle: (id: string, wanted: boolean) => void;
  readonly unlocked: boolean;
}): JSX.Element {
  const { approved, boxId, chosen, id, onToggle, unlocked } = props;
  const locked = approved && !unlocked;
  const toggle = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onToggle(id, event.target.checked),
    [id, onToggle]
  );

  return (
    <label className={locked ? "field-check pick-locked" : "field-check"} htmlFor={boxId}>
      <input
        checked={locked || chosen}
        disabled={locked}
        id={boxId}
        onChange={toggle}
        type="checkbox"
      />
      <code>{id}</code>
    </label>
  );
}

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
  /** Whether an approved picture may be chosen; see `pickable`. */
  readonly unlocked: boolean;
  readonly urlOf: (id: string) => string;
}): JSX.Element {
  const { chosen, idPrefix, items, onToggle, unlocked, urlOf } = props;

  return (
    <ul className="pictures">
      {items.map((item) => (
        <Shown
          chosen={chosen.includes(item.id)}
          idPrefix={idPrefix}
          item={item}
          key={item.id}
          onToggle={onToggle}
          unlocked={unlocked}
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
  readonly unlocked: boolean;
  readonly url: string;
}): JSX.Element {
  const { chosen, idPrefix, item, onToggle, unlocked, url } = props;

  return (
    <li className={item.approved ? "picture picture-approved" : "picture"}>
      {onToggle === null ? (
        <p className="picture-name">
          <code>{item.id}</code>
        </p>
      ) : (
        <PickBox
          approved={item.approved}
          boxId={`${idPrefix}-${item.id}`}
          chosen={chosen}
          id={item.id}
          onToggle={onToggle}
          unlocked={unlocked}
        />
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
