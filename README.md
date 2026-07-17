# ship

A small CLI that polls the Vercel API and sends a macOS notification when a deployment changes state.

Runs in the foreground. No relay server, no background daemon, no persistent config.

## Install

```
git clone https://github.com/terrence-celestine/vercel-deployment-watcher
cd ship
npm install
```

## Setup

You'll need a Vercel API token. Generate one at [vercel.com/account/tokens](https://vercel.com/account/tokens), then export it:

```
export VERCEL_TOKEN="your_token_here"
```

Add that line to `~/.zshrc` (or `~/.bashrc`) to make it stick across shells.

## Usage

```
npm start -- --interval 60
```

Flags:

- `-i, --interval <seconds>` — how often to poll Vercel. Default `60`. Minimum `5`.
- `--simulate` — skip the real API and cycle through fake deployments. Useful for testing without waiting on a real deploy.

Ctrl+C to stop. The tool prints a summary of what it's watching on the first poll, then stays quiet unless a deployment's state changes.

## How it works

On each tick, `ship` fetches recent deployments from `/v6/deployments`, compares each one's `readyState` against what it saw last tick, and notifies on any transition.

A few notes on the shape:

- Uses `setTimeout` recursion instead of `setInterval` so a slow request never overlaps the next poll.
- Tracks per-deployment state in a `Map<uid, readyState>` so it can detect transitions across ticks without conflating deployments.
- Handles `SIGINT` to exit cleanly and print a final poll count.
- The first poll silently populates the Map — no notifications on startup, only on real transitions.
- Notifications use `Glass` for successful transitions and `Basso` for errors, played through `osascript`.

## Notification icon

macOS attributes the notification to whichever app called `osascript`, which means the icon will be a generic script icon. Swapping this for a custom icon requires either `terminal-notifier` or wrapping the CLI in a proper `.app` bundle. Neither is included here.

## Files

- `ship.ts` — CLI entry point, poll loop, state tracking
- `notify.ts` — `osascript` wrapper for macOS notifications

## Requirements

- Node 20+
- macOS (notifications use `osascript`)
- A Vercel account with at least one deployment