import { type ChangeEvent, type JSX, useCallback, useEffect, useState } from "react";
import { Ladder } from "./ladder";
import { ThemeSelect } from "./theme";
import type { EpisodeStatus, Refusal, WorkspaceListing } from "./types";

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

/** The first episode anybody could be looking at, when nothing is chosen yet. */
function firstEpisode(listing: WorkspaceListing): { episode: string; project: string } | null {
  for (const project of listing.projects) {
    const [episode] = project.episodes;

    if (episode !== undefined) {
      return { episode, project: project.id };
    }
  }

  return null;
}

export function App(): JSX.Element {
  const [listing, setListing] = useState<WorkspaceListing | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [episodeId, setEpisodeId] = useState<string | null>(null);
  const [status, setStatus] = useState<EpisodeStatus | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [connection, setConnection] = useState<Connection>("opening");

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

      const first = firstEpisode(body);

      if (first !== null) {
        setProjectId(first.project);
        setEpisodeId(first.episode);
      }
    };

    read().catch(() => {
      if (!cancelled) {
        setRefusal("Serwer nie odpowiada. Uruchom go poleceniem pnpm ui.");
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (projectId === null || episodeId === null) {
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
    events.addEventListener("error", () => setConnection("stale"));

    return () => events.close();
  }, [episodeId, projectId]);

  const project = listing?.projects.find((one) => one.id === projectId) ?? null;
  const note = CONNECTION_NOTE[connection];

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
        {note === null ? null : (
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
        {status === null ? null : <Ladder status={status} />}
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
