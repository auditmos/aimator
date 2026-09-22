import { type ChangeEvent, type JSX, useCallback, useEffect, useState } from "react";
import { CharacterPanel } from "./character";
import { Ladder } from "./ladder";
import { OpeningFramePanel } from "./opening-frame";
import { PreparePanel } from "./prepare";
import { PromptPackagePanel } from "./prompt-package";
import { ReferencesPanel } from "./references";
import { ScreenplayPanel } from "./screenplay";
import { ShotListPanel } from "./shot-list";
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
const PANELLED = new Set([0, 1, 2, 3, 4, 5, 6]);

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

  return props.cell.stage === 6 ? <OpeningFramePanel {...props} /> : null;
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

  const openCell = useCallback((id: string) => {
    setRun(null);
    setOpened((current) => (current === id ? null : id));
  }, []);

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
        <div className="picker">
          <div className="field">
            <label htmlFor="project">Projekt</label>
            <select
              disabled={listing === null}
              id="project"
              onChange={chooseProject}
              value={projectId ?? ""}
            >
              {listing?.projects.map((one) => (
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
              onChange={chooseEpisode}
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
        <Notices
          connection={connection}
          ladderless={ladderless}
          listing={listing}
          project={project}
          refusal={refusal}
        />
        {status === null ? null : (
          <Ladder onOpen={openCell} openable={openable} opened={opened} status={status} />
        )}
        {preparing ? (
          <PreparePanel
            cell={panel}
            episodeId={episodeId}
            onRun={start}
            projectId={project?.id ?? null}
            run={run}
            running={running}
          />
        ) : null}
        {panel === null || projectId === null || episodeId === null ? null : (
          <StagePanel
            cell={panel}
            episodeId={episodeId}
            onRun={start}
            projectId={projectId}
            run={run}
            running={running}
          />
        )}
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
