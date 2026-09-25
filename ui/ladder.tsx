import { type JSX, useCallback, useEffect, useState } from "react";
import { plural, type Unit } from "./panel";
import type { CellState, EpisodeStatus, StatusCell } from "./types.js";

/**
 * The ladder of one episode, read at two distances.
 *
 * `status` hands over one cell per stage, per character and per track: two
 * dozen rows for an episode with two characters. Shown at once, beside an open
 * panel, that was a wall a person had to read end to end to find the one row
 * they came for. So the ladder is read twice instead. From afar it is eleven
 * stages, one row each, which is the question "where is this episode"; up
 * close it is one stage, with its tracks and characters as tabs over the one
 * panel that is open, which is the question "what do I do here".
 *
 * Every word still comes off the object the server handed over. Grouping by
 * stage and counting states is arithmetic over those cells, never a verdict:
 * the five states keep their text labels beside their colour, and the reason a
 * cell is blocked is the stage's own sentence, quoted rather than summarised.
 */

const LABEL: Record<CellState, string> = {
  approved: "zatwierdzony",
  blocked: "zablokowany",
  ready: "gotowy do generowania",
  review: "do przeglądu",
  running: "w toku",
};

/**
 * What a stage is called when it is spoken of as a whole.
 *
 * A cell's own title names one row of it ("postać ewa", "narracja, miks"), so
 * the name of the stage those rows share is this client's, like the headings
 * each panel already carries.
 */
const STAGE_NAME: Readonly<Record<number, string>> = {
  0: "przygotowanie",
  1: "scenariusz",
  2: "postacie",
  3: "lista ujęć",
  4: "pakiet promptów",
  5: "referencje",
  6: "klatka otwarcia",
  7: "klipy",
  8: "montaż",
  9: "narracja",
  10: "muzyka i efekty",
};

export function stageName(stage: number): string {
  return STAGE_NAME[stage] ?? `etap ${stage}`;
}

/** One stage and every cell `status` gave it, in the order it gave them. */
interface Stage {
  readonly cells: readonly StatusCell[];
  readonly stage: number;
}

export function stagesOf(status: EpisodeStatus): readonly Stage[] {
  const stages: { cells: StatusCell[]; stage: number }[] = [];

  for (const cell of status.cells) {
    const last = stages.at(-1);

    if (last?.stage === cell.stage) {
      last.cells.push(cell);
    } else {
      stages.push({ cells: [cell], stage: cell.stage });
    }
  }

  return stages;
}

/**
 * Which of a stage's cells this is, in as few words as tell them apart.
 *
 * Stage 2 differs by character and track, stages 5 to 8 by track, and stages 9
 * and 10 by level: the half after the comma in the cell's own title is what
 * separates the shared words from a track's mix.
 */
function variantOf(cell: StatusCell): string {
  const level = cell.title.includes(", ") ? (cell.title.split(", ").at(-1) ?? null) : null;

  return [level, cell.character, cell.track].filter((part) => part !== null).join(" · ");
}

/** The order a person should look in: what moves first, what is finished last. */
const URGENCY: readonly CellState[] = ["running", "review", "ready", "blocked", "approved"];

/** How many cells of a stage stand in each state, most pressing first. */
function tally(cells: readonly StatusCell[]): readonly { count: number; state: CellState }[] {
  return URGENCY.map((state) => ({
    count: cells.filter((cell) => cell.state === state).length,
    state,
  })).filter((one) => one.count > 0);
}

/** The one state a stage is drawn in when it is one mark on a strip. */
function leading(cells: readonly StatusCell[]): CellState {
  return tally(cells)[0]?.state ?? "blocked";
}

/**
 * The cell a stage opens on when nobody named one.
 *
 * The one `status` called next if it is here, else the first that still wants
 * something, else the first: arriving on a finished track while its sibling
 * waits for review would be sending a person to the wrong tab.
 */
export function defaultCell(stage: Stage, next: string | null): StatusCell | null {
  return (
    stage.cells.find((cell) => cell.id === next) ??
    stage.cells.find((cell) => cell.state !== "approved") ??
    stage.cells[0] ??
    null
  );
}

/** Where a stage, or one cell of it, lives in the address. */
export type HrefOf = (place: string) => string;

const COPY_NOTE: Record<Copied, string | null> = {
  done: "Skopiowane do schowka.",
  failed: "Przeglądarka nie dała dostępu do schowka; zaznacz i skopiuj ręcznie.",
  idle: null,
};

type Copied = "done" | "failed" | "idle";

/**
 * The command `status` suggests, folded away under the plain-language step.
 *
 * It is the terminal's spelling of the same move, kept for whoever drives the
 * pipeline from there, and folded because a sentence of flags is not what a
 * person reads first. "Kopiuj" copies exactly what is on screen: a stage's
 * `nextStep` is the stage's own words, and trimming it here would be the
 * screen editing an answer it did not write.
 */
function Terminal(props: { readonly command: string }): JSX.Element {
  const { command } = props;
  const [copied, setCopied] = useState<Copied>("idle");
  const copy = useCallback(() => {
    navigator.clipboard.writeText(command).then(
      () => setCopied("done"),
      () => setCopied("failed")
    );
  }, [command]);

  // A note about a command that is no longer on screen would be a lie about
  // what is in the clipboard right now.
  useEffect(() => {
    setCopied("idle");
  }, [command]);

  return (
    <details className="next-terminal">
      <summary>Polecenie w terminalu</summary>
      <code className="next-command">{command}</code>
      <div className="next-actions">
        <button className="action" onClick={copy} type="button">
          Kopiuj
        </button>
        <span aria-live="polite" className="next-copied">
          {COPY_NOTE[copied]}
        </span>
      </div>
    </details>
  );
}

/** The one next move, said as a place to go rather than as a command to type. */
function NextStep(props: { readonly hrefOf: HrefOf; readonly status: EpisodeStatus }): JSX.Element {
  const { hrefOf, status } = props;

  if (status.next === null) {
    return (
      <div className="next-card next-card-done">
        <p className="next-label">Następny krok</p>
        <p className="next-what">Odcinek zamknięty: każdy etap zatwierdzony.</p>
      </div>
    );
  }

  const cell = status.cells.find((one) => one.id === status.next?.cell) ?? null;

  return (
    <div className="next-card">
      <p className="next-label">Następny krok</p>
      {cell === null ? null : (
        <p className="next-what">
          <span className="next-stage">Etap {cell.stage}</span> {stageName(cell.stage)}
          {variantOf(cell) === "" ? null : <span className="next-where">{variantOf(cell)}</span>}
          <span className={`state state-${cell.state}`}>{LABEL[cell.state]}</span>
        </p>
      )}
      {cell === null ? null : (
        <a className="action action-primary next-go" href={hrefOf(cell.id)}>
          Przejdź do etapu {cell.stage}
        </a>
      )}
      <Terminal command={status.next.command} />
    </div>
  );
}

/**
 * How a stage's cells stand: one label when they agree, counts when they do not.
 *
 * "zatwierdzony 3/3" says nothing "zatwierdzony" does not, so a count appears
 * only where it tells the rows of one stage apart.
 */
function Tally(props: { readonly cells: readonly StatusCell[] }): JSX.Element {
  const counts = tally(props.cells);
  const agreed = counts.length === 1;

  return (
    <span className="stage-tally">
      {counts.map((one) => (
        <span className={`state state-${one.state}`} key={one.state}>
          {agreed ? LABEL[one.state] : `${LABEL[one.state]} ${one.count}/${props.cells.length}`}
        </span>
      ))}
    </span>
  );
}

const CHARACTERS: Unit = ["postać", "postacie", "postaci"];
const TRACKS: Unit = ["tor", "tory", "torów"];

/**
 * What a stage's rows are, counted in their own axes.
 *
 * Stage 2 is characters times tracks, stages 5 to 8 are tracks, and stages 9
 * and 10 are one shared half plus a half per track.
 */
function partsOf(cells: readonly StatusCell[]): string {
  const characters = new Set(cells.flatMap((cell) => cell.character ?? [])).size;
  const tracks = plural(new Set(cells.flatMap((cell) => cell.track ?? [])).size, TRACKS);

  if (characters > 0) {
    return `${plural(characters, CHARACTERS)} × ${tracks}`;
  }

  return cells.some((cell) => cell.track === null) ? `wspólna część + ${tracks}` : tracks;
}

/**
 * The episode from afar: where it stands, and one row per stage.
 *
 * Each row is a link to that stage's own page, which is where its tracks,
 * characters, notes and actions are. Nothing else is on this screen, so the
 * eye reads down eleven rows and not twenty-three.
 */
export function EpisodeOverview(props: {
  readonly hrefOf: HrefOf;
  readonly status: EpisodeStatus;
}): JSX.Element {
  const { hrefOf, status } = props;
  const nextStage = status.cells.find((cell) => cell.id === status.next?.cell)?.stage ?? null;

  return (
    <section aria-labelledby="ladder-title" className="overview">
      <NextStep hrefOf={hrefOf} status={status} />
      <h2 className="overview-title" id="ladder-title">
        Etapy
      </h2>
      <ol className="stages">
        {stagesOf(status).map((one) => (
          <li className="stage-item" key={one.stage}>
            <a
              className={one.stage === nextStage ? "stage-row stage-row-next" : "stage-row"}
              href={hrefOf(String(one.stage))}
            >
              <span className="stage-no">{one.stage}</span>
              <span className="stage-name">
                {stageName(one.stage)}
                {one.cells.length === 1 ? null : (
                  <span className="stage-count">{partsOf(one.cells)}</span>
                )}
              </span>
              <Tally cells={one.cells} />
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * Every stage as one mark on a strip, for moving between them.
 *
 * Each mark is drawn in the most pressing state among its cells, with the
 * state in its accessible name as well, since a colour alone says nothing to
 * a screen reader or in a screenshot.
 */
export function StageNav(props: {
  readonly current: number;
  readonly hrefOf: HrefOf;
  readonly stages: readonly Stage[];
}): JSX.Element {
  const { current, hrefOf, stages } = props;

  return (
    <nav aria-label="Etapy odcinka" className="stepper">
      <ol>
        {stages.map((one) => {
          const state = leading(one.cells);

          return (
            <li key={one.stage}>
              <a
                aria-current={one.stage === current ? "page" : undefined}
                aria-label={`Etap ${one.stage}: ${stageName(one.stage)}, ${LABEL[state]}`}
                className={`step step-${state}`}
                href={hrefOf(String(one.stage))}
                title={`${stageName(one.stage)}: ${LABEL[state]}`}
              >
                <span className="step-no">{one.stage}</span>
                <span className="step-name">{stageName(one.stage)}</span>
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * The tracks, characters or levels of one stage, as tabs over one panel.
 *
 * A stage with one cell has nothing to choose between and shows nothing.
 */
export function Variants(props: {
  readonly current: string;
  readonly hrefOf: HrefOf;
  readonly stage: Stage;
}): JSX.Element | null {
  const { current, hrefOf, stage } = props;

  if (stage.cells.length < 2) {
    return null;
  }

  return (
    <nav aria-label={`Części etapu ${stage.stage}`} className="variants">
      <ul>
        {stage.cells.map((cell) => (
          <li key={cell.id}>
            <a
              aria-current={cell.id === current ? "page" : undefined}
              className="variant"
              href={hrefOf(cell.id)}
            >
              <span className="variant-name">{variantOf(cell)}</span>
              <span className={`state state-${cell.state}`}>{LABEL[cell.state]}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The stages either side of this one, named, for reading the episode in order. */
export function Neighbours(props: {
  readonly current: number;
  readonly hrefOf: HrefOf;
  readonly stages: readonly Stage[];
}): JSX.Element {
  const { current, hrefOf, stages } = props;
  const at = stages.findIndex((one) => one.stage === current);
  const before = at > 0 ? stages[at - 1] : undefined;
  const after = at >= 0 ? stages[at + 1] : undefined;

  return (
    <nav aria-label="Sąsiednie etapy" className="neighbours">
      {before === undefined ? (
        <span />
      ) : (
        <a href={hrefOf(String(before.stage))}>
          ← Etap {before.stage}: {stageName(before.stage)}
        </a>
      )}
      {after === undefined ? null : (
        <a className="neighbour-next" href={hrefOf(String(after.stage))}>
          Etap {after.stage}: {stageName(after.stage)} →
        </a>
      )}
    </nav>
  );
}

/**
 * The whole episode as one mark: finished, or still wanting work.
 *
 * Finished means every stage is approved, read off the same `status` the
 * ladder is drawn from, cell by cell; a stage with one track approved and the
 * other waiting is not finished, because the film it feeds is not. The number
 * beside the unfinished mark counts stages rather than cells, since stages are
 * what the strip above an episode shows.
 */
export function Readiness(props: {
  readonly status: EpisodeStatus | "loading" | "refused";
}): JSX.Element {
  const { status } = props;

  if (status === "loading") {
    return <span className="readiness readiness-loading">sprawdzam…</span>;
  }

  if (status === "refused") {
    return <span className="readiness readiness-unknown">stan nieznany</span>;
  }

  const stages = stagesOf(status);
  const done = stages.filter((one) => one.cells.every((cell) => cell.state === "approved")).length;
  const finished = stages.length > 0 && done === stages.length;

  return finished ? (
    <span className="readiness readiness-done">
      <svg aria-hidden="true" className="readiness-icon" viewBox="0 0 16 16">
        <circle cx="8" cy="8" fill="currentColor" r="8" />
        <path
          d="M4.5 8.2 7 10.6l4.6-5"
          fill="none"
          stroke="var(--color-neutral-950)"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.8"
        />
      </svg>
      gotowy
    </span>
  ) : (
    <span className="readiness readiness-work">
      <svg aria-hidden="true" className="readiness-icon" viewBox="0 0 16 16">
        <circle cx="8" cy="8" fill="none" r="7" stroke="currentColor" strokeWidth="1.5" />
        {done === 0 ? null : <path d={wedge(done / stages.length)} fill="currentColor" />}
      </svg>
      wymaga pracy · {done} z {stages.length} etapów
    </span>
  );
}

/** A slice of a 4.5-unit disc from twelve o'clock, clockwise, `share` of the way round. */
function wedge(share: number): string {
  const angle = share * 2 * Math.PI;
  const x = 8 + 4.5 * Math.sin(angle);
  const y = 8 - 4.5 * Math.cos(angle);

  return `M8 8 L8 3.5 A4.5 4.5 0 ${share > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)} Z`;
}
