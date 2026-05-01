# AI Workflow Note

## Tools

- **Claude Code (Opus 4.7)** — primary collaborator. Used for design exploration,
  scaffolding, drafting tests, and the ADR structure.
- **Visual Studio Code + macOS terminal** — for the actual code writing, running tests, debugging.
  AI suggestions were applied as edits I read line by line, not as black-box patches.

## Process

1. **Design first, code second.** I spent a good amount of time designing and then engineering the prompt
    , listing what's specified vs intentionally left open
   ("what does reconciled mean when offline?", "out-of-order events?"), and narrowing the
   transport / storage / language choices via explicit pros/cons. 

2. **Decisions stayed mine.** When the AI offered options (e.g. long-poll vs short-poll vs
   MQTT), I asked it to lay out the trade-offs and picked. Recommendations were treated as
   defaults to challenge, not answers to accept.

3. **Failure modes drove the test list.** I wrote out the failure modes I cared about
   (out-of-order, transient retry, give-up, offline, drift, idempotent re-delivery) before
   implementing them.

## Kept vs threw away

**Kept:**
- The dual-trigger reconciliation pattern (fast path on check-in + 10s background sweep).
  This was the AI's suggestion when I described "devices behind firewalls" — I challenged
  it ("why two triggers, isn't one enough?") and the answer (latency vs liveness
  separation) held up, so it stayed.
- Distinguishing `DRIFTING` from `FAILED_TRANSIENT` as separate states. Initially I had
  them merged; the prompt's specific call-out of "drift from genuine failure" pushed me
  to split them, and once split they wanted different observability.
- SQLite over Postgres for the take-home. Reviewer-friendly (no infra to spin up), still
  gives a real transactional store.

**Threw away:**
- An earlier draft had a per-device async worker queue inside the backend. It
  was solving a problem I don't have at 100 devices, and obscured the state machine.
  The 10s sweep does the same job with less code.
- A long-polling transport sketch. Killed during the trade-off table as there was not enough latency
  benefit at this scale to justify the connection management complexity.
- An over-engineered observability layer (SSE feed, live dashboard with WS). Replaced
  with a static HTML page that polls `/rollup` every 2s. 

## What I specifically verified

- **Read every generated file.**  Every test, every state
  transition function got a manual read-through.
- **Tests exercise real behavior, not mocks of behavior.** Failure-mode tests drive the
  HTTP API and assert against the real SQLite store + state log.
