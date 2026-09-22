import { type JSX, useCallback, useEffect, useState } from "react";
import type { CellState, EpisodeStatus, StatusCell } from "./types.js";

/**
 * The ladder of one episode, cell by cell, in the order it is climbed.
 *
 * Every word here comes off the object the server handed over. The five states
 * carry a text label beside their colour, because colour alone says nothing to
 * a person who cannot see it and nothing at all in a screenshot; the reason a
 * cell is blocked is the stage's own sentence, quoted rather than summarised;
 * and the one highlighted row is the one `status` itself called next.
 *
 * A refusal and a report are different things and are drawn differently: the
 * reason a stage gives for standing still sits in the cell, while what it says
 * without refusing (a silent cut, a missing soundtrack) is a note under it.
 * The CLI prints `!` and `·` for the same distinction.
 */

const LABEL: Record<CellState, string> = {
  approved: "zatwierdzony",
  blocked: "zablokowany",
  ready: "gotowy do generowania",
  review: "do przeglądu",
  running: "w toku",
};

/** Which of the two axes this cell belongs to, when it belongs to one. */
function where(cell: StatusCell): string | null {
  const parts = [cell.character, cell.track].filter((part) => part !== null);

  return parts.length === 0 ? null : parts.join(" · ");
}

const COPY_NOTE: Record<Copied, string | null> = {
  done: "Skopiowane do schowka.",
  failed: "Przeglądarka nie dała dostępu do schowka; zaznacz i skopiuj ręcznie.",
  idle: null,
};

type Copied = "done" | "failed" | "idle";

/**
 * The one next move, and the two things a person can actually do with it.
 *
 * It used to be a cyan badge reading "Dalej" beside a line of text, which is
 * the one shape a screen must not have: it looked like a button, did nothing
 * when clicked, and left the sentence beside it with no use. So the label
 * stops pretending and the two real uses become buttons. Opening the stage is
 * this client's own navigation rather than a command, which is why it is
 * allowed: `status` already said which cell this is, and the panel it opens
 * runs the same `run(argv)` as every other one.
 *
 * "Kopiuj" copies exactly what is on screen, which is sometimes a bare command
 * and sometimes a sentence with one inside it, because a stage's `nextStep` is
 * the stage's own words. Trimming it to what looks like a command here would
 * be the screen editing an answer it did not write.
 */
function Next(props: {
  readonly cell: StatusCell | null;
  readonly command: string;
  /** Set only where the next cell has a panel to open. */
  readonly onOpen: ((id: string) => void) | null;
}): JSX.Element {
  const { cell, command, onOpen } = props;
  const [copied, setCopied] = useState<Copied>("idle");
  const open = useCallback(() => {
    if (cell !== null) {
      onOpen?.(cell.id);
    }
  }, [cell, onOpen]);
  const copy = useCallback(() => {
    navigator.clipboard.writeText(command).then(
      () => setCopied("done"),
      () => setCopied("failed")
    );
  }, [command]);

  // A note about a command that is no longer on screen would be a lie about
  // what is in the schowek right now.
  useEffect(() => {
    setCopied("idle");
  }, [command]);

  return (
    <div className="next-step">
      <p className="next-label" id="next-label">
        Następny krok
      </p>
      <code className="next-command">{command}</code>
      <div className="next-actions">
        {cell === null || onOpen === null ? null : (
          <button className="action action-primary" onClick={open} type="button">
            Pokaż etap {cell.stage}
          </button>
        )}
        <button className="action" onClick={copy} type="button">
          Kopiuj
        </button>
        <span aria-live="polite" className="next-copied">
          {COPY_NOTE[copied]}
        </span>
      </div>
    </div>
  );
}

interface CellProps {
  readonly cell: StatusCell;
  readonly isNext: boolean;
  readonly isOpen: boolean;
  /** Set only where a panel exists; the other stages arrive one slice at a time. */
  readonly onOpen: ((id: string) => void) | null;
}

function Cell(props: CellProps): JSX.Element {
  const { cell, isNext, isOpen, onOpen } = props;
  const open = useCallback(() => onOpen?.(cell.id), [cell.id, onOpen]);
  const place = where(cell);
  const notices = cell.status?.notices ?? [];
  const classes = ["cell", isNext ? "cell-next" : "", isOpen ? "cell-open" : ""]
    .filter((name) => name !== "")
    .join(" ");
  const body = (
    <>
      <span className="cell-stage">{cell.stage}</span>
      <span className="cell-title">
        {cell.title}
        {place === null ? null : <span className="cell-where">{place}</span>}
      </span>
      <span className={`state state-${cell.state}`}>{LABEL[cell.state]}</span>
    </>
  );

  return (
    <li className={classes}>
      {onOpen === null ? (
        <span className="cell-body">{body}</span>
      ) : (
        <button
          aria-expanded={isOpen}
          className="cell-body cell-button"
          onClick={open}
          type="button"
        >
          {body}
        </button>
      )}
      {cell.reason === null ? null : <p className="cell-reason">{cell.reason}</p>}
      {notices.map((notice) => (
        <p className="cell-notice" key={notice}>
          {notice}
        </p>
      ))}
    </li>
  );
}

export function Ladder(props: {
  readonly onOpen: (id: string) => void;
  readonly opened: string | null;
  /** Which cells have a panel today. A cell without one stays a row. */
  readonly openable: (cell: StatusCell) => boolean;
  readonly status: EpisodeStatus;
}): JSX.Element {
  const { onOpen, openable, opened, status } = props;
  const next = status.cells.find((cell) => cell.id === status.next?.cell) ?? null;

  return (
    <section aria-labelledby="ladder-title" className="ladder-section">
      <div className="next">
        <h2 id="ladder-title">
          Odcinek {status.episodeId}, projekt {status.projectId}
        </h2>
        {status.next === null ? (
          <p className="next-done">Odcinek zamknięty: każdy etap zatwierdzony.</p>
        ) : (
          <Next
            cell={next}
            command={status.next.command}
            onOpen={next !== null && openable(next) ? onOpen : null}
          />
        )}
      </div>
      <ol className="ladder">
        {status.cells.map((cell) => (
          <Cell
            cell={cell}
            isNext={cell.id === status.next?.cell}
            isOpen={cell.id === opened}
            key={cell.id}
            onOpen={openable(cell) ? onOpen : null}
          />
        ))}
      </ol>
    </section>
  );
}
