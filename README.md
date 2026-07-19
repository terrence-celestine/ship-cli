# ship

A small CLI that polls the Vercel API and sends a macOS notification when a deployment finishes.

Runs in the foreground. No relay server, no background daemon, no persistent config.

## Install

```
git clone https://github.com/terrence-celestine/ship-cli
cd ship-cli
npm install
```

## Setup

You'll need a Vercel API token. Generate one at [vercel.com/account/tokens](https://vercel.com/account/tokens), then export it:

```
export VERCEL_TOKEN="your_token_here"
```

Add that line to `~/.zshrc` (or `~/.bashrc`) to make it stick across shells. `ship` checks for the token at startup and exits with these instructions if it's missing.

To try it without a token first, run `npm start -- --simulate`.

## Usage

```
npm start -- --interval 60
```

Flags:

- `-i, --interval <seconds>` — how often to poll Vercel. Default `60`. Minimum `5`.
- `-s, --simulate` — skip the real API and cycle through fake deployments. Useful for testing without waiting on a real deploy.
- `-f, --filter <projects>` — watch only these projects. Comma-separated, case-insensitive substring match, so `--filter cart,fit` picks up `cartly` and `fitlog`. If a filter matches nothing on the first successful poll, `ship` names that filter and keeps watching — the deployment may not exist yet.
- `-n, --notify <mode>` — when to send macOS notifications. `terminal` (default) notifies only when a deployment finishes; `all` notifies on every transition; `none` sends no banners at all. See [Notifications](#notifications).
- `-t, --team <slug>` — watch a Vercel team's deployments. Accepts a team slug or a `team_`-prefixed id. **Without this, only your personal deployments are visible** — see [Scope](#scope).
- `-l, --limit <n>` — how many recent deployments to watch, `1`–`100`. Defaults to `20`, or wider when `--filter` narrows to several projects.

The tool prints what it's watching on the first successful poll, then stays quiet unless a deployment's state changes. While it waits, a status line at the bottom shows the current state tallies and a countdown to the next poll:

```
3 ready · 1 building · next poll in 23s
```

That line is TTY-only. Redirect or pipe the output and it disappears entirely, so logs stay clean.

## Session summary

Ctrl+C prints what the session actually saw, rather than just a poll count:

```
✋ Session summary
   Watched for 41 min · 41 polls

   project    changes   ok   failed   avg build
   fitlog           4    2        0         47s
   cartly           3    1        1         12s
   splittab         0    0        0           —

   3 succeeded, 1 failed · avg build 30s across 4 builds
```

Projects that never changed still get a row, so you can tell "nothing happened" apart from "wasn't being watched". Note that `ok + failed` won't always equal `changes` — a transition to `CANCELED` is neither a success nor a failure.

## Scope

The Vercel API returns only the token owner's **personal** deployments unless you scope the request to a team — and it returns an empty list rather than an error, so an unscoped run against team projects looks like "nothing is deploying" rather than "you're looking in the wrong place". If you see no deployments, try:

```
ship --team your-team-slug
```

`ship` prints that hint itself when an unscoped run comes back empty.

### How `--filter` finds quiet projects

`--filter` used to slice the most recent handful of deployments account-wide, which meant a busy project could crowd a quiet one out of the window entirely — `--filter quiet-proj` would watch nothing, indefinitely, with no way to tell that apart from "nothing has happened yet".

Now, when you pass `--filter` against the real API, `ship` lists your projects once at startup, substring-matches the names there, and asks Vercel for just those projects' deployments. Matching semantics are unchanged: still case-insensitive substring, so `--filter cart` still finds `cartly`.

- A filter matching no project still warns and keeps watching, in case the project appears later.
- A filter matching more than 20 projects falls back to the recent-deployments window, and says so.
- `--simulate` skips resolution entirely — there's no project list to resolve against.

## When the API misbehaves

- A missing `VERCEL_TOKEN` fails at startup with setup instructions, rather than 403-ing silently on every tick. `--simulate` doesn't need one.
- A `401`/`403` mid-session is fatal: a rejected token never self-heals, so `ship` prints the summary and exits `1` instead of retrying forever.
- Transient failures (5xx, network drops) back off exponentially from the poll interval up to 5 minutes, and the countdown reflects the longer wait so you know why it went quiet. The first poll to succeed afterwards prints a `recovered after N failed polls` line.
- Requests time out after 10s, or the poll interval, whichever is shorter.

## Notifications

A single deploy walks `QUEUED → BUILDING → READY`, so notifying on every state change means two or three banners for one deploy. By default `ship` only notifies when a deployment **finishes** — `READY`, `ERROR`, or `CANCELED` — and picks the sound from the outcome:

| state | sound |
| --- | --- |
| `READY` | `Glass` |
| `ERROR` | `Basso` |
| `CANCELED` | `Pop` |

`--notify all` restores a banner on every transition (intermediate states get `Pop`, since they aren't outcomes). `--notify none` sends no banners at all and never spawns `osascript`.

**The mode only gates the banner and the sound.** Change lines still print in every mode, including `--notify none` — the scrollback is the record of what happened and when, which a transient banner is a poor substitute for. The interruption was the problem, not the logging.

When a deployment finishes, its URL is appended to the change line and included in the notification body:

```
[2:15:09 PM] change cartly : BUILDING -> READY (52s) https://cartly-abc123.vercel.app
```

It's plain text rather than a terminal hyperlink escape, so redirected output stays free of escape sequences — cmd-click works in Terminal.app, iTerm2, WezTerm, Ghostty and VS Code regardless. In-flight transitions don't get a URL, since the host isn't serving the new build yet.

## Notification limits

macOS attributes the notification to whichever app called `osascript`, which means the icon will be a generic script icon. For the same reason the notification is not clickable — `osascript display notification` has no way to attach an open-URL action, so the deploy URL appears as body text you can read and select, but not click. Fixing either would need `terminal-notifier` or wrapping the CLI in a proper `.app` bundle. Neither is included here.

There is deliberately no `--open` flag. Auto-opening a browser on a timer turns a busy afternoon into fifteen tabs, and on `ERROR` it opens pages that don't load. Cmd-clicking a printed URL gets you there with a human in the loop.

## How it works

On each tick, `ship` fetches recent deployments from `/v6/deployments`, compares each one's `readyState` against what it saw last tick, and logs any transition. When `--filter` is set it also calls `/v10/projects` once at startup to turn project names into ids.

A few notes on the shape:

- Uses `setTimeout` recursion instead of `setInterval` so a slow request never overlaps the next poll.
- Tracks per-deployment state in a `Map<uid, readyState>` so it can detect transitions across ticks without conflating deployments.
- Handles `SIGINT` to exit cleanly and print the session summary. A second Ctrl+C won't print it twice.
- Sets `process.exitCode` rather than calling `process.exit()`, so the multi-line summary isn't truncated when stdout is a pipe.
- The first poll silently populates the Map — no notifications on startup, only on real transitions.
- Notification text is passed to `osascript` via `execFile`, so a project name containing quotes or backslashes can't break out into the shell.

## Files

- `ship.ts` — CLI entry point, poll loop, state tracking, session summary
- `scope.ts` — team scoping, project resolution, and URL building
- `status.ts` — the rewriting status line (no-ops when stdout isn't a TTY)
- `api.ts` — `Deployment` type, which states count as terminal, and the fixtures behind `--simulate`
- `notify.ts` — `osascript` wrapper for macOS notifications
- `test/` — `node:test` suites

## Tests

```
npm test          # run once
npm run test:watch
npm run typecheck
```

Uses `node:test` via `tsx`, so there's no test framework dependency. The suites cover the pure logic — AppleScript escaping and script assembly, duration formatting boundaries, backoff clamps, summary rendering and column alignment, URL construction, project matching, and pagination.

Deliberately not automated: terminal rendering of the status line, actual notification banners and sounds, and anything against the live Vercel API. Those are faster to check by eye — `npm start -- --simulate --interval 5` exercises all of them. To confirm nothing leaks escape sequences into piped output, count ESC bytes directly:

```
npm start -- --simulate | LC_ALL=C tr -cd '\033' | wc -c    # expect 0
```

(Don't reach for `xxd | grep -c 1b` — it matches `1b` in the offset column too.)

## Requirements

- Node 20.3+ (the request timeout uses `AbortSignal.any`, added in 20.3.0)
- macOS (notifications use `osascript`)
- A Vercel account with at least one deployment — or `--simulate`, which needs neither