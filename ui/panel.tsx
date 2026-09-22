import { type ChangeEvent, type JSX, useCallback, useEffect, useState } from "react";
import { commandLine } from "../src/ui/commands.js";
import type { RunDone } from "./types";

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

export function Command(props: { readonly argv: readonly string[] }): JSX.Element {
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

/** What the resolver is asked for: what an artifact is, never where it lives. */
interface ArtifactRef {
  readonly artifact: string;
  readonly episodeId: string;
  readonly projectId: string;
  readonly stage: string;
}

function artifactUrl(one: ArtifactRef): string {
  return `/api/artifact/${one.projectId}/${one.episodeId}/${one.stage}/${one.artifact}`;
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
