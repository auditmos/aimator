---
name: bugfix
description: Fix a reported bug by first reproducing it in a failing test, then getting the fix approved, then confirming the full suite still passes. Use whenever the user reports something broken, wrong, failing, crashing, hanging, or behaving unexpectedly — "there's a bug", "X is broken", "this returns the wrong value", "it crashes when I", "this used to work", "regression", "nie działa", "napraw to", "popraw błąd" — and also when a failing test, red CI job, stack trace, or production error points at a defect. Use it even when the fix looks obvious in the first ten seconds, because the failing test is the only thing that proves the bug was reproduced rather than guessed at. Not for new features, refactors, performance work, or code review.
---

# Bugfix — reproduce before you repair

The failure mode this exists to prevent: reading a bug report, forming a plausible
theory, changing code that matches the theory, and declaring victory — without ever
having observed the bug. When the theory is wrong, the result is a confident fix to
a bug nobody had, while the reported one survives.

A test that fails *before* the fix and passes *after* is the cheapest available proof
that you and the user are talking about the same defect.

## 1. Reproduce it in a failing test

Write one test that fails for the reported reason. Change no implementation code yet.

Keep the test narrow — reproduce what was reported, not adjacent things you noticed.
A test carrying three concerns fails for three reasons and stops being evidence.

**If the test passes on the first run, stop.** You have not reproduced the bug; you
have written a test for behaviour that already works. This is the single most useful
signal in the whole workflow, and it means one of:

- the repro steps differ from what the user actually did — ask
- the bug depends on state, ordering, or environment the test doesn't recreate
- the bug is real but lives at a different layer than you assumed

Do not proceed to a fix from a green test. Whatever you change next would be
unfalsifiable.

## 2. Show the failing test and the proposed fix — then stop

Report: the test, its actual failure output, your diagnosis of the cause, and what
you intend to change. Then wait.

This gate is cheap and catches the expensive mistakes. The user knows things not
visible from the code: whether your repro matches what they saw, whether the line
you're about to touch is load-bearing for something else, whether the "bug" is
intended behaviour that some other caller depends on.

Exception worth honouring: if the user has already said to just fix it and not ask,
skip the wait — but still write the test first and still show both together with the
result. The approval is theirs to waive; the evidence isn't.

## 3. Fix it

Make the failing test pass. Scope discipline here is governed by the always-on
`dev-bugfix-discipline` rule — fix minimally, never refactor while fixing, and if
three consecutive attempts fail, revert and rethink rather than piling on edits.

Keep the test. It is now a regression guard, and deleting it discards the only
durable artifact of this work.

## 4. Confirm nothing else broke

Run the full test suite, not just the new test. A change that fixes one case and
breaks two others is not a fix, and the only way to know is to run everything.

Report the actual result. If something else went red, say so plainly rather than
reporting the targeted test's success alone.

## When a failing test genuinely isn't possible

Some defects resist this — a visual glitch, a race that won't reproduce
deterministically, a failure that needs real hardware, third-party network
behaviour, or a codebase with no test framework at all.

Say so explicitly and propose the closest falsifiable substitute: a script that
demonstrates it, a log line proving the bad state is reached, a manual repro with
exact steps and observed-versus-expected output. Then continue with the same shape —
evidence first, approval, fix, verify.

What matters is that something could have shown you were wrong. Silently skipping
step 1 because it was awkward is the one move this workflow exists to prevent.
