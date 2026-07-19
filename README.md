# ship

A small CLI that polls the Vercel API and sends a macOS notification when a deployment changes state.

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

   3 succeeded, 1 failed · avg build 35s across 4 builds
```

Projects that never changed still get a row, so you can tell "nothing happened" apart from "wasn't being watched". Note that `ok + failed` won't always equal `changes` — a transition to `CANCELED` is neither a success nor a failure.

## When the API misbehaves

- A missing `VERCEL_TOKEN` fails at startup with setup instructions, rather than 403-ing silently on every tick. `--simulate` doesn't need one.
- A `401`/`403` mid-session is fatal: a rejected token never self-heals, so `ship` prints the summary and exits `1` instead of retrying forever.
- Transient failures (5xx, network drops) back off exponentially from the poll interval up to 5 minutes, and the countdown reflects the longer wait so you know why it went quiet. The first poll to succeed afterwards prints a `recovered after N failed polls` line.
- Requests time out after 10s, or the poll interval, whichever is shorter.

## How it works

On each tick, `ship` fetches recent deployments from `/v6/deployments`, compares each one's `readyState` against what it saw last tick, and notifies on any transition.

A few notes on the shape:

- Uses `setTimeout` recursion instead of `setInterval` so a slow request never overlaps the next poll.
- Tracks per-deployment state in a `Map<uid, readyState>` so it can detect transitions across ticks without conflating deployments.
- Handles `SIGINT` to exit cleanly and print the session summary. A second Ctrl+C won't print it twice.
- Sets `process.exitCode` rather than calling `process.exit()`, so the multi-line summary isn't truncated when stdout is a pipe.
- The first poll silently populates the Map — no notifications on startup, only on real transitions.
- Notifications use `Glass` for successful transitions and `Basso` for errors, played through `osascript`.

## Notification icon

macOS attributes the notification to whichever app called `osascript`, which means the icon will be a generic script icon. Swapping this for a custom icon requires either `terminal-notifier` or wrapping the CLI in a proper `.app` bundle. Neither is included here.

## Files

- `ship.ts` — CLI entry point, poll loop, state tracking, session summary
- `status.ts` — the rewriting status line (no-ops when stdout isn't a TTY)
- `api.ts` — `Deployment` type and the fixtures behind `--simulate`
- `notify.ts` — `osascript` wrapper for macOS notifications

## Requirements

- Node 20.3+ (the request timeout uses `AbortSignal.any`, added in 20.3.0)
- macOS (notifications use `osascript`)
- A Vercel account with at least one deployment — or `--simulate`, which needs neither