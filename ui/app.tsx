import {
  type ChangeEvent,
  type JSX,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { AssemblyPanel } from "./assembly";
import { CharacterPanel } from "./character";
import { ClipsPanel } from "./clips";
import { Ladder } from "./ladder";
import { MixPanel, NarrationPanel } from "./narration";
import { OpeningFramePanel } from "./opening-frame";
import { PreparePanel } from "./prepare";
import { PromptPackagePanel } from "./prompt-package";
import { ReferencesPanel } from "./references";
import { ScreenplayPanel } from "./screenplay";
import { ShotListPanel } from "./shot-list";
import { MasterPanel, SoundDesignPanel } from "./sound-design";
import { ThemeSelect } from "./theme";
import type {
  EpisodeStatus,
  ListedProject,
  Refusal,
  RunDone,
  StatusCell,
  WorkspaceListing,
} from "./types";

/**
 * One screen: what is in the workspace, and where one episode stands.
 *
 * Both answers are commands. The picker is `list`, the ladder is `status`, and
 * the stream is the same `status` asked again whenever the workspace moves, so
 * a window open here and an agent working in a terminal cannot drift apart.
 *
 * The one state this client owns is **whether what it shows is current**. An
 * event stream that drops does not make the last ladder wrong, only old, so it
 * stays on the screen and says so; a tool that blanked itself would be hiding
 * the answer a person is in the middle of reading, and one that kept pretending
 * would be worse. That is § 9 of the design manual: a network failure never
 * masquerades as a fresh result.
 */

type Connection = "live" | "opening" | "stale";

const CONNECTION_NOTE: Record<Connection, string | null> = {
  live: null,
  opening: "Czytam stan odcinka…",
  stale: "Brak połączenia z serwerem. Poniżej ostatni znany stan, nieaktualny.",
};

/**
 * Which cells can be opened today.
 *
 * One stage, one slice: the rest are driven from the terminal until theirs
 * arrives. A row nobody can open says so by being a row, which is more honest
 * than a panel apologising for being empty.
 */
const PANELLED = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

function openable(cell: StatusCell): boolean {
  return PANELLED.has(cell.stage);
}

interface PanelProps {
  readonly cell: StatusCell;
  readonly episodeId: string;
  readonly onRun: (argv: readonly string[]) => void;
  readonly projectId: string;
  readonly run: RunDone | null;
  readonly running: boolean;
}

/**
 * Which stage's panel the open cell gets, and nothing else.
 *
 * One `if` per stage rather than a lookup table, because a panel is a
 * component with its own props and a table of them would be a type that means
 * nothing. Stage 0 is not here: it is the one panel that has to exist before
 * there is a cell to open.
 */
function StagePanel(props: PanelProps): JSX.Element | null {
  if (props.cell.stage === 1) {
    return <ScreenplayPanel {...props} />;
  }

  // Stage 2 is the one cell that is not about an episode: a character recurs
  // between them, so its panel is handed the character and the track its cell
  // carries and nothing else.
  if (props.cell.stage === 2) {
    return (
      <CharacterPanel
        cell={props.cell}
        onRun={props.onRun}
        projectId={props.projectId}
        run={props.run}
        running={props.running}
      />
    );
  }

  if (props.cell.stage === 3) {
    return <ShotListPanel {...props} />;
  }

  if (props.cell.stage === 4) {
    return <PromptPackagePanel {...props} />;
  }

  if (props.cell.stage === 5) {
    return <ReferencesPanel {...props} />;
  }

  if (props.cell.stage === 6) {
    return <OpeningFramePanel {...props} />;
  }

  if (props.cell.stage === 7) {
    return <ClipsPanel {...props} />;
  }

  if (props.cell.stage === 8) {
    return <AssemblyPanel {...props} />;
  }

  // Stage 9 is the first stage with two panels, because its artifacts live at
  // two levels: the words are shared by both tracks and the mix is not. The
  // cell's own track is what says which of the two questions this row is.
  if (props.cell.stage === 9) {
    return props.cell.track === null ? <NarrationPanel {...props} /> : <MixPanel {...props} />;
  }

  // Stage 10 splits the same way and for the same reason: the cue sheet and
  // the stems are bought once for both films, and only the full mix is timed
  // against a particular cut.
  if (props.cell.stage === 10) {
    return props.cell.track === null ? <SoundDesignPanel {...props} /> : <MasterPanel {...props} />;
  }

  return null;
}

/**
 * What the screen says about itself: the connection, a refusal, an empty tree.
 *
 * All three are the same kind of statement and none of them is a result, which
 * is why they sit together and above everything that is one. § 9 of the design
 * manual is the rule they follow: a lost stream leaves the last ladder on
 * screen and says it is old, and an empty workspace says so plainly rather
 * than looking like a tool that failed to load.
 */
function Notices(props: {
  readonly connection: Connection;
  /** Suppressed where stage 0 is the whole screen: there is no ladder to be stale. */
  readonly ladderless: boolean;
  readonly listing: WorkspaceListing | null;
  readonly project: ListedProject | null;
  readonly refusal: string | null;
}): JSX.Element {
  const { connection, ladderless, listing, project, refusal } = props;
  const note = CONNECTION_NOTE[connection];

  return (
    <>
      {note === null || ladderless ? null : (
        <p aria-live="polite" className={`connection connection-${connection}`}>
          {note}
        </p>
      )}
      {refusal === null ? null : (
        <p className="refusal" role="alert">
          {refusal}
        </p>
      )}
      {listing !== null && listing.projects.length === 0 ? (
        <p className="empty">Katalog roboczy nie ma jeszcze żadnego projektu.</p>
      ) : null}
      {project !== null && project.episodes.length === 0 ? (
        <p className="empty">Projekt {project.id} nie ma jeszcze odcinka.</p>
      ) : null}
    </>
  );
}

/**
 * A panel that opened somewhere a person is not looking has not opened.
 *
 * The two-column layout answers this for a wide window: the panel stands
 * beside the row that was clicked and is in view already, so `nearest` moves
 * nothing. A narrow window stacks, and there the panel lands below the whole
 * ladder, which is the arrangement this replaces: a click whose result is
 * off-screen. The panel takes focus either way, because a keyboard and a
 * screen reader are in exactly the position a scrolled-past panel leaves the
 * eye in. An anchor overrides both: it names a form inside the panel, and the
 * point of naming it is to put it at the top.
 */
function useReveal(props: {
  readonly anchor: string | null;
  readonly opened: string | null;
  readonly panel: RefObject<HTMLDivElement | null>;
  readonly showing: boolean;
}): void {
  const { anchor, opened, panel, showing } = props;

  useEffect(() => {
    // A stage-0 panel standing in for an empty workspace opened itself; there
    // was no click, so nothing has moved and nothing should be moved to.
    if (!showing || (opened === null && anchor === null)) {
      return;
    }

    const wide = window.matchMedia("(min-width: 64rem)").matches;
    const part = anchor === null ? null : document.getElementById(anchor);

    (part ?? panel.current)?.scrollIntoView({
      behavior: "smooth",
      block: wide && part === null ? "nearest" : "start",
    });
    panel.current?.focus({ preventScroll: true });
  }, [anchor, opened, panel, showing]);
}

/**
 * The ladder and the panel of the row somebody opened, side by side.
 *
 * They are one component because they are one answer: a click on a row and
 * the thing that click produced. Under them the panel used to be rendered
 * after the whole ladder, so opening a cell near the top of a twenty-row
 * episode put the result below the fold with nothing on screen saying
 * anything had happened. A wide window now puts the two in columns and keeps
 * the panel in view while the ladder scrolls; a narrow one stacks them and
 * the client scrolls to the panel instead.
 *
 * Stage 0 is the exception that shapes the rest: it has a panel and may have
 * no ladder at all, so the grid drops to one column rather than leaving an
 * empty half beside a form.
 */
function Workbench(props: {
  readonly anchor: string | null;
  readonly cell: StatusCell | null;
  readonly episodeId: string | null;
  readonly onClose: () => void;
  readonly onOpen: (id: string) => void;
  readonly onRun: (argv: readonly string[]) => void;
  readonly opened: string | null;
  readonly preparing: boolean;
  readonly projectId: string | null;
  readonly run: RunDone | null;
  readonly running: boolean;
  readonly status: EpisodeStatus | null;
}): JSX.Element {
  const { anchor, cell, episodeId, onClose, onOpen, onRun, opened, preparing, status } = props;
  const { projectId, run, running } = props;
  const panelRef = useRef<HTMLDivElement>(null);
  const showing = preparing || cell !== null;
  const stage = cell === null || projectId === null || episodeId === null ? null : cell;

  useReveal({ anchor, opened, panel: panelRef, showing });

  return (
    <div className={status !== null && showing ? "workbench workbench-split" : "workbench"}>
      {status === null ? null : (
        <div className="workbench-ladder">
          <Ladder onOpen={onOpen} openable={openable} opened={opened} status={status} />
        </div>
      )}
      {showing ? (
        // `tabIndex` because opening a cell moves focus here: the panel is the
        // answer to that click, and a keyboard has to land in it.
        <div className="workbench-panel" ref={panelRef} tabIndex={-1}>
          {opened === null ? null : (
            <div className="panel-bar">
              <button className="panel-close" onClick={onClose} type="button">
                Zamknij panel
              </button>
            </div>
          )}
          {preparing ? (
            <PreparePanel
              cell={cell}
              episodeId={episodeId}
              onRun={onRun}
              projectId={projectId}
              run={run}
              running={running}
            />
          ) : null}
          {stage === null || projectId === null || episodeId === null ? null : (
            <StagePanel
              cell={stage}
              episodeId={episodeId}
              onRun={onRun}
              projectId={projectId}
              run={run}
              running={running}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * What this screen is looking at, and the two ways into something that is not
 * in the workspace yet.
 *
 * Two dropdowns alone answered only half the question. They say which project
 * and which episode are being shown, and they have no word at all for "I want
 * a new one", which left the only road into stage 0 running through a row of
 * a ladder that an empty workspace does not have. The buttons are that road,
 * and they are buttons rather than an entry in the lists because starting
 * something new is not one of the things you can pick.
 */
function Picker(props: {
  readonly episodeId: string | null;
  readonly onEpisode: (event: ChangeEvent<HTMLSelectElement>) => void;
  readonly onNewEpisode: () => void;
  readonly onNewProject: () => void;
  readonly onProject: (event: ChangeEvent<HTMLSelectElement>) => void;
  readonly project: ListedProject | null;
  readonly projectId: string | null;
  /** Null until `list` has answered; empty once it has and found nothing. */
  readonly projects: readonly ListedProject[] | null;
}): JSX.Element {
  const { episodeId, onEpisode, onNewEpisode, onNewProject, onProject, project, projectId } = props;
  const projects = props.projects ?? [];

  return (
    <section aria-labelledby="picker-title" className="picker-section">
      <h2 className="picker-title" id="picker-title">
        Nad czym pracujesz
      </h2>
      <div className="picker">
        <div className="field">
          <label htmlFor="project">Projekt</label>
          <select
            disabled={projects.length === 0}
            id="project"
            onChange={onProject}
            value={projectId ?? ""}
          >
            {projects.map((one) => (
              <option key={one.id} value={one.id}>
                {one.id}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="episode">Odcinek</label>
          <select
            disabled={project === null || project.episodes.length === 0}
            id="episode"
            onChange={onEpisode}
            value={episodeId ?? ""}
          >
            {project?.episodes.map((one) => (
              <option key={one} value={one}>
                {one}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="picker-actions">
        <button className="action" onClick={onNewProject} type="button">
          + Nowy projekt
        </button>
        <button
          className="action"
          disabled={projectId === null}
          onClick={onNewEpisode}
          type="button"
        >
          + Nowy odcinek
        </button>
        <p className="picker-note">
          Oba otwierają etap 0: to tam pusty katalog staje się serią, a projekt bez odcinka dostaje
          pierwszy.
        </p>
      </div>
    </section>
  );
}

export function App(): JSX.Element {
  const [listing, setListing] = useState<WorkspaceListing | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [episodeId, setEpisodeId] = useState<string | null>(null);
  const [status, setStatus] = useState<EpisodeStatus | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [connection, setConnection] = useState<Connection>("opening");
  const [opened, setOpened] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [run, setRun] = useState<RunDone | null>(null);
  /**
   * Which part of the open panel a person was asking for, when they asked for
   * a part of it. "Nowy projekt" and "Nowy odcinek" open the same stage-0
   * panel, so what tells them apart is where the panel is scrolled to; a
   * panel opened from the ladder has no such part and leaves this null.
   */
  const [anchor, setAnchor] = useState<string | null>(null);

  /**
   * The workspace's own contents, re-read whenever a command finishes.
   *
   * Stage 0 is why: a project and an episode are things this screen can
   * create, and a picker that only read once would not show what the person
   * just made. Every other command leaves the listing exactly as it was, so
   * re-reading it costs one directory walk and never lies.
   */
  useEffect(() => {
    let cancelled = false;

    const read = async (): Promise<void> => {
      const response = await fetch("/api/projects");
      const body = (await response.json()) as Refusal | WorkspaceListing;

      if (cancelled) {
        return;
      }

      if ("error" in body) {
        setRefusal(body.error.message);

        return;
      }

      setListing(body);
    };

    read().catch(() => {
      if (!cancelled) {
        setRefusal("Serwer nie odpowiada. Uruchom go poleceniem pnpm ui.");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [run]);

  /** The first thing anybody could be looking at, when nothing is chosen yet. */
  useEffect(() => {
    if (listing === null) {
      return;
    }

    const chosen = listing.projects.find((one) => one.id === projectId) ?? listing.projects[0];

    if (chosen === undefined) {
      return;
    }

    if (projectId === null) {
      setProjectId(chosen.id);
    }

    if (episodeId === null || !chosen.episodes.includes(episodeId)) {
      setEpisodeId(chosen.episodes[0] ?? null);
    }
  }, [episodeId, listing, projectId]);

  useEffect(() => {
    if (projectId === null || episodeId === null) {
      setStatus(null);

      return;
    }

    setStatus(null);
    setRefusal(null);
    setConnection("opening");

    const events = new EventSource(`/api/events/${projectId}/${episodeId}`);

    events.addEventListener("status", (event) => {
      setStatus(JSON.parse(event.data) as EpisodeStatus);
      setRefusal(null);
      setConnection("live");
    });
    events.addEventListener("refusal", (event) => {
      setRefusal((JSON.parse(event.data) as Refusal).error.message);
      setConnection("live");
    });
    // A command started here finishes here, whatever else the screen is doing
    // meanwhile. An identifier this window did not start is somebody else's.
    events.addEventListener("run", (event) => setRun(JSON.parse(event.data) as RunDone));
    events.addEventListener("error", () => setConnection("stale"));

    return () => events.close();
  }, [episodeId, projectId]);

  /**
   * One click, one command, and nothing waited for.
   *
   * The answer is an identifier; what the command said arrives on the stream,
   * because a clip is bought by a call that polls for minutes and the screen
   * has to stay usable while it does.
   */
  const start = useCallback((argv: readonly string[]) => {
    setRun(null);
    setPending(null);

    fetch("/api/run", {
      body: JSON.stringify({ argv }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
      .then(async (response) => (await response.json()) as { runId?: string })
      .then((body) => setPending(body.runId ?? null))
      .catch(() =>
        setRun({
          error: { message: "Serwer nie przyjął komendy.", name: "NetworkError" },
          ok: false,
          runId: "",
        })
      );
  }, []);

  /**
   * Opening a cell forgets the last command, **both halves of it**.
   *
   * `run` alone is half a fact. What "w toku" is derived from is the pair: an
   * identifier this window is waiting for, and the answer that has not come
   * back under it yet. Clearing the answer and keeping the identifier made
   * every finished command look like one still in flight, which disabled every
   * button in the panel just opened, and there is no way out of that: starting
   * a command is what clears it, and the buttons that start one are the
   * disabled ones. Two states, one fact, cleared together.
   *
   * Nothing is lost while a real command is running: the result arrives on the
   * stream whatever is open, and the cell itself says "w toku" off the stage's
   * own lock file, which is the only progress this server claims to know.
   */
  const openCell = useCallback((id: string) => {
    setRun(null);
    setPending(null);
    setAnchor(null);
    setOpened((current) => (current === id ? null : id));
  }, []);
  const close = useCallback(() => {
    setAnchor(null);
    setOpened(null);
  }, []);
  /**
   * Stage 0 reached from the picker rather than from the ladder.
   *
   * A workspace that already holds a project has a ladder, and the only way
   * into "a project that does not exist yet" was to know that stage 0's row
   * opens the form. That is a road nobody finds. Both buttons open the same
   * panel, because it is one stage; what differs is which of its forms the
   * panel is scrolled to.
   */
  const openPrepare = useCallback(
    (part: string) => {
      setRun(null);
      setPending(null);
      setAnchor(part);
      setOpened(status?.cells.find((cell) => cell.stage === 0)?.id ?? null);
    },
    [status]
  );
  const newProject = useCallback(() => openPrepare("prepare-new-project"), [openPrepare]);
  const newEpisode = useCallback(() => openPrepare("prepare-episode"), [openPrepare]);

  const project = listing?.projects.find((one) => one.id === projectId) ?? null;
  /**
   * Still running, derived rather than remembered.
   *
   * A `check` finishes in milliseconds, so its result can reach the stream
   * before the request that started it has answered with the identifier. A
   * flag cleared by the event would then be set again afterwards and never
   * cleared, leaving "w toku" under a result that is already on screen. The
   * identifier the result carries is the proof, so the two are compared.
   */
  const running = pending !== null && run?.runId !== pending;
  // The panel renders the cell the ladder is carrying right now, so a finished
  // command refreshes what the panel says without the panel asking anything.
  const panel = status?.cells.find((cell) => cell.id === opened && openable(cell)) ?? null;
  /**
   * Stage 0 is reachable even when there is no ladder to open it from.
   *
   * That is not a convenience: an empty workspace has no project, a fresh
   * project has no episode, and `status` answers about an episode. Stage 0 is
   * what makes the rest exist, so it is the one panel that cannot be behind
   * the thing it produces.
   */
  const ladderless =
    listing !== null && (project === null || project.episodes.length === 0 || refusal !== null);
  const preparing = panel?.stage === 0 || ladderless;

  /** Choosing a project chooses its first episode: no empty in-between. */
  const chooseProject = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const chosen = listing?.projects.find((one) => one.id === event.target.value);

      setProjectId(event.target.value);
      setEpisodeId(chosen?.episodes[0] ?? null);
    },
    [listing]
  );
  const chooseEpisode = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => setEpisodeId(event.target.value),
    []
  );

  return (
    <>
      <a className="skip-link" href="#main">
        Przejdź do treści
      </a>
      <header className="app-header">
        <div className="header-inner wrap">
          <div className="brand">
            <img
              alt="Auditmos"
              className="logo logo-dark"
              height="134"
              src="/auditmos-wordmark-cyan-transparent.svg"
              width="738"
            />
            <img
              alt="Auditmos"
              className="logo logo-light"
              height="134"
              src="/auditmos-wordmark-black-transparent.svg"
              width="738"
            />
            <span className="product">aimator</span>
          </div>
          <ThemeSelect />
        </div>
      </header>
      <main className="wrap" id="main">
        <h1>Drabina etapów</h1>
        <p className="intro">
          Stan jednego odcinka, etap po etapie, prosto z komend <code>list</code> i{" "}
          <code>status</code>. Odświeża się sam, gdy coś w katalogu roboczym się zmieni.
        </p>
        <Picker
          episodeId={episodeId}
          onEpisode={chooseEpisode}
          onNewEpisode={newEpisode}
          onNewProject={newProject}
          onProject={chooseProject}
          project={project}
          projectId={projectId}
          projects={listing?.projects ?? null}
        />
        <Notices
          connection={connection}
          ladderless={ladderless}
          listing={listing}
          project={project}
          refusal={refusal}
        />
        <Workbench
          anchor={anchor}
          cell={panel}
          episodeId={episodeId}
          onClose={close}
          onOpen={openCell}
          onRun={start}
          opened={opened}
          preparing={preparing}
          // The project the listing actually holds, never the one this client
          // last remembered: a panel aimed at a directory nobody has any more
          // would spell commands the CLI can only refuse.
          projectId={project?.id ?? null}
          run={run}
          running={running}
          status={status}
        />
      </main>
      <footer className="app-footer">
        <div className="wrap">
          <p>Auditmos OÜ · Reg 17025406 · VAT EE102758111</p>
          <p className="workspace">
            Katalog roboczy: <code>{listing?.workspace ?? "…"}</code>
          </p>
        </div>
      </footer>
    </>
  );
}
