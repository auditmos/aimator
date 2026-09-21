import { watch } from "node:fs";

/**
 * How long the tree has to sit still before it counts as changed.
 *
 * A stage does not write one file: it writes a lock, then bytes, then its
 * state file, and a viewer that recomputed after each of those would show two
 * ladders nobody was ever in. The wait is short enough to stay well inside the
 * two seconds the contract allows between a change and the screen showing it.
 */
const SETTLE_MS = 150;

/**
 * Tells one caller that something under this tree changed. Never what.
 *
 * That is the whole design: progress here is exactly as detailed as the state
 * a stage wrote to disk, so the answer to "what changed" is the same `status`
 * call an agent would make, not a diff assembled by the watcher. Anything
 * finer would mean the server knowing what a stage's files mean, which is the
 * one thing it must never learn.
 *
 * The watcher is not persistent: the server's socket is what keeps this
 * process alive, and a viewer who closed the tab must not.
 */
export function watchWorkspace(root: string, onChange: () => void): () => void {
  let settling: NodeJS.Timeout | undefined;
  const watcher = watch(root, { persistent: false, recursive: true }, () => {
    clearTimeout(settling);
    settling = setTimeout(onChange, SETTLE_MS);
  });

  return () => {
    clearTimeout(settling);
    watcher.close();
  };
}
