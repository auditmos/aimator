import type { JSX } from "react";
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

function Cell(props: { readonly cell: StatusCell; readonly isNext: boolean }): JSX.Element {
  const { cell, isNext } = props;
  const place = where(cell);
  const notices = cell.status?.notices ?? [];

  return (
    <li className={isNext ? "cell cell-next" : "cell"}>
      <span className="cell-stage">{cell.stage}</span>
      <span className="cell-title">
        {cell.title}
        {place === null ? null : <span className="cell-where">{place}</span>}
      </span>
      <span className={`state state-${cell.state}`}>{LABEL[cell.state]}</span>
      {cell.reason === null ? null : <p className="cell-reason">{cell.reason}</p>}
      {notices.map((notice) => (
        <p className="cell-notice" key={notice}>
          {notice}
        </p>
      ))}
    </li>
  );
}

export function Ladder(props: { readonly status: EpisodeStatus }): JSX.Element {
  const { status } = props;

  return (
    <section aria-labelledby="ladder-title" className="ladder-section">
      <div className="next">
        <h2 id="ladder-title">
          Odcinek {status.episodeId}, projekt {status.projectId}
        </h2>
        {status.next === null ? (
          <p className="next-done">Odcinek zamknięty: każdy etap zatwierdzony.</p>
        ) : (
          <p className="next-command">
            <span className="next-label">Dalej</span>
            <code>{status.next.command}</code>
          </p>
        )}
      </div>
      <ol className="ladder">
        {status.cells.map((cell) => (
          <Cell cell={cell} isNext={cell.id === status.next?.cell} key={cell.id} />
        ))}
      </ol>
    </section>
  );
}
