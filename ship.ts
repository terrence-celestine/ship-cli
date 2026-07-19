#!/usr/bin/env -S npx tsx

import { Command } from "commander"
import chalk from "chalk"
import { notify } from "./notify.js"
import { Deployment, getSimulatedDeployments } from "./api.js"
import { createStatusLine } from "./status.js"

const MS_PER_MIN = 60_000;
const MS_PER_HR = 60 * MS_PER_MIN;
const MS_PER_DAY = 24 * MS_PER_HR;

const MAX_BACKOFF_MS = 5 * MS_PER_MIN
const MAX_TIMEOUT_MS = 10_000
const MAX_TRACKED_FAILURES = 20 // keeps 2 ** n away from Infinity

/** A rejected token never self-heals, so these are fatal rather than retried. */
class AuthError extends Error { }

interface ProjectStats {
  name: string
  transitions: number
  successes: number
  failures: number
  durations: number[] // ms, only recorded when the API gave us both timestamps
}

interface SessionStats {
  startedAt: number
  polls: number
  errors: number
  projects: Map<string, ProjectStats> // keyed by projectId, the stable identifier
}

interface WatchOptions {
  intervalSec: number
  simulate: boolean
  token?: string
  filters?: string[]
}

const program = new Command()

program
  .name("ship")
  .description("Watch for vercel deployment changes and notify on change")
  .version("0.1.0")
  .option("-i, --interval <seconds>", "polling interval in seconds", "60")
  .option("-s, --simulate", "use fake deployment data to cycle through deployment states")
  .option("-f, --filter <projects>", "watch only these projects (comma-separated, case-insensitive substring match)")
  .action(async (options: { interval: string; simulate?: boolean, filter?: string }) => {
    const intervalSec = Number(options.interval)

    if (Number.isNaN(intervalSec) || intervalSec < 5) {
      console.error(chalk.red(`Interval must be a number >= 5 seconds. Got: ${options.interval}`))
      process.exit(1)
    }

    let filters: string[] | undefined
    if (options.filter !== undefined) {
      filters = options.filter.split(",").map(f => f.trim().toLowerCase()).filter(f => f.length > 0)

      if (filters.length === 0) {
        console.error(chalk.red(`Filter must name at least one project. Got: ${options.filter}`))
        process.exit(1)
      }
    }

    // Trimmed, so an empty or whitespace-only export reads as missing rather
    // than 403-ing on every tick forever. --simulate never needs a token.
    const token = process.env.VERCEL_TOKEN?.trim()
    if (!options.simulate && !token) {
      console.error(chalk.red("VERCEL_TOKEN is not set."))
      console.error(chalk.dim("   Generate a token at https://vercel.com/account/tokens, then:"))
      console.error(chalk.dim(`   export VERCEL_TOKEN="your_token_here"`))
      console.error(chalk.dim(`   See "Setup" in the README.`))
      process.exit(1)
    }

    await runWatchLoop({ intervalSec, simulate: options.simulate ?? false, token, filters })
  })

const formatDuration = (ms: number): string => {
  if (ms < 1000) return "< 1s"
  if (ms < MS_PER_MIN) return `${Math.round(ms / 1000)}s`; // time is less than 1 min
  if (ms < MS_PER_HR) return `${Math.round(ms / MS_PER_MIN)} min`; // time is less than 1 hour
  if (ms < MS_PER_DAY) return `${Math.round(ms / MS_PER_HR)} hr`; // time is less than a full day
  return `${Math.round(ms / MS_PER_DAY)} days` // time is in days
}

const average = (values: number[]): number =>
  values.reduce((sum, v) => sum + v, 0) / values.length

const tally = (deployments: Deployment[]): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const d of deployments) counts.set(d.readyState, (counts.get(d.readyState) ?? 0) + 1)
  return counts
}

/** Pure so it stays easy to eyeball — returns lines, prints nothing. */
const renderSummary = (session: SessionStats, now: number): string[] => {
  const lines: string[] = []
  const polls = `${session.polls} ${session.polls === 1 ? "poll" : "polls"}`
  const errors = session.errors > 0
    ? ` · ${session.errors} ${session.errors === 1 ? "error" : "errors"}`
    : ""

  lines.push(chalk.bold("✋ Session summary"))
  lines.push(chalk.dim(`   Watched for ${formatDuration(now - session.startedAt)} · ${polls}${errors}`))

  const rows = [...session.projects.values()]
  if (rows.every(p => p.transitions === 0)) {
    lines.push(chalk.dim("   No state changes observed."))
    return lines
  }

  rows.sort((a, b) => b.transitions - a.transitions || a.name.localeCompare(b.name))

  const cellAvg = (durations: number[]): string =>
    durations.length === 0 ? "—" : formatDuration(average(durations))

  // Pad the plain strings, then colorize. Padding a chalk-wrapped string counts
  // the ANSI bytes as visible width and shears the columns.
  const headers = ["project", "changes", "ok", "failed", "avg build"]
  const cells = rows.map(p => [
    p.name,
    String(p.transitions),
    String(p.successes),
    String(p.failures),
    cellAvg(p.durations),
  ])
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map(c => c[i].length)))
  const layout = (values: string[]): string =>
    "   " + values.map((v, i) => (i === 0 ? v.padEnd(widths[i]) : v.padStart(widths[i] + 3))).join("")

  lines.push("")
  lines.push(chalk.dim(layout(headers)))
  for (const c of cells) lines.push(layout(c))

  const allDurations = rows.flatMap(p => p.durations)
  const succeeded = rows.reduce((sum, p) => sum + p.successes, 0)
  const failed = rows.reduce((sum, p) => sum + p.failures, 0)

  let footer = `${succeeded} succeeded, ${failed} failed`
  if (allDurations.length > 0) {
    footer += ` · avg build ${formatDuration(average(allDurations))} across ${allDurations.length} ${allDurations.length === 1 ? "build" : "builds"}`
  }

  lines.push("")
  lines.push(chalk.dim(footer.padStart(footer.length + 3)))

  return lines
}

async function runWatchLoop({ intervalSec, simulate, token, filters }: WatchOptions): Promise<void> {
  console.log(chalk.bold(`👀 Watching Vercel Deployments`))
  console.log(chalk.dim(`   Polling every ${intervalSec}s · Ctrl+C to stop`))
  console.log()

  const status = createStatusLine()
  const lastStates: Map<string, string> = new Map();
  const session: SessionStats = { startedAt: Date.now(), polls: 0, errors: 0, projects: new Map() }

  const baseDelayMs = intervalSec * 1000
  // Clamped to the interval: at -i 5 an unclamped 10s timeout would leave the
  // tool hung more often than it polls.
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, baseDelayMs)

  let consecutiveFailures = 0
  let announced = false // gates the opening summary on the first *successful* poll
  let pollTimer: NodeJS.Timeout | null = null
  let inFlight: AbortController | null = null
  let shuttingDown = false

  const nextDelayMs = (): number =>
    consecutiveFailures === 0
      ? baseDelayMs
      // The cap must never fall below the configured interval, or -i 600 would
      // poll *more* often while failing than while healthy.
      : Math.min(baseDelayMs * 2 ** consecutiveFailures, Math.max(MAX_BACKOFF_MS, baseDelayMs))

  const scheduleNext = (): number => {
    const delay = nextDelayMs()
    if (shuttingDown) return delay
    status.setNextPollAt(Date.now() + delay)
    pollTimer = setTimeout(poll, delay)
    return delay
  }

  const shutdown = (code: number): void => {
    if (shuttingDown) return
    shuttingDown = true

    status.stop() // must clear before the summary prints, or it splices onto the countdown
    if (pollTimer) clearTimeout(pollTimer)
    inFlight?.abort() // don't let a pending request hold the process open

    console.log()
    for (const line of renderSummary(session, Date.now())) console.log(line)

    // Not process.exit(): that can truncate pending stdout when piped, and the
    // summary is multi-line. Both timers are cleared, so the loop drains.
    process.exitCode = code
  }

  process.on("SIGINT", () => shutdown(0))
  process.on("exit", () => status.clear())

  const trackProject = (d: Deployment): ProjectStats => {
    let stats = session.projects.get(d.projectId)
    if (!stats) {
      stats = { name: d.name, transitions: 0, successes: 0, failures: 0, durations: [] }
      session.projects.set(d.projectId, stats)
    }
    return stats
  }

  const poll = async (): Promise<void> => {
    if (shuttingDown) return

    session.polls += 1
    status.setNextPollAt(null) // renders "polling…", which also shows a hung request
    const timestamp = new Date().toLocaleTimeString()

    try {
      let deployments: Deployment[];

      if (simulate) {
        deployments = getSimulatedDeployments()
      } else {
        const controller = new AbortController()
        inFlight = controller
        try {
          const res = await fetch("https://api.vercel.com/v6/deployments?limit=5", {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
          })
          if (res.status === 401 || res.status === 403) {
            throw new AuthError(`Vercel API: ${res.status} — token rejected or lacks access to this scope`)
          }
          if (!res.ok) throw new Error(`Vercel API: ${res.status}`)
          const data = await res.json() as { deployments: Deployment[] }
          deployments = data.deployments
        } finally {
          inFlight = null
        }
      }

      // Which filters matched nothing? Worth calling out, since a typo'd filter
      // and a quiet deployment look identical once we're past the first poll.
      const unmatched = filters?.filter(f => !deployments.some(d => d.name.toLowerCase().includes(f))) ?? []

      if (filters) {
        deployments = deployments.filter(d => filters.some(f => d.name.toLowerCase().includes(f)))
      }

      // Keyed off the first success, not poll 1 — if the opening poll errors and
      // then backs off, you'd otherwise never learn what's being watched.
      if (!announced) {
        announced = true
        const projectCount = new Set(deployments.map(d => d.projectId)).size
        status.log(chalk.dim(`[${timestamp}]`), chalk.cyan("watching"), `${deployments.length} ${deployments.length === 1 ? "deployment" : "deployments"} across ${projectCount} ${projectCount === 1 ? "project" : "projects"}`)

        if (filters) {
          status.log(chalk.dim(`   ${filters.length === 1 ? "filter" : "filters"}: ${filters.join(", ")}`))
          for (const f of unmatched) {
            status.log(chalk.dim(`   ⚠ nothing matched "${f}" — will keep watching`))
          }
        } else if (deployments.length === 0) {
          status.log(chalk.dim(`   No deployments found — will keep watching`))
        }
      }

      for (const d of deployments) {
        // Seeded every poll, not just on transitions, so quiet projects still
        // show up in the summary as a row of zeros.
        const stats = trackProject(d)
        const previous = lastStates.get(d.uid); // look up the deployment by the UID

        // Hoisted so the message and the stats read the same value.
        const duration = (d.readyState === "READY" || d.readyState === "ERROR") && d.buildingAt && d.ready
          ? d.ready - d.buildingAt
          : undefined

        if (previous !== undefined && previous !== d.readyState) {
          // we found the deployment but the ready states dont match, a change occured
          let message = `${previous} -> ${d.readyState}`
          if (duration !== undefined) message += ` (${formatDuration(duration)})`

          stats.transitions += 1
          if (d.readyState === "READY") stats.successes += 1
          else if (d.readyState === "ERROR") stats.failures += 1
          if (duration !== undefined) stats.durations.push(duration)

          status.log(
            chalk.dim(`[${timestamp}]`),
            chalk.yellow("change"),
            `${d.name} : ${message}`
          )
          const sound = d.readyState === "ERROR" ? "Basso" : "Glass";
          notify(`State changed in ${d.name}`, message, sound)
        }
        lastStates.set(d.uid, d.readyState); // set the deployment by UID
      }

      status.setTallies(tally(deployments))

      if (consecutiveFailures > 0) {
        // Without this the tool just goes quiet and you never learn it recovered.
        status.log(chalk.dim(`[${timestamp}]`), chalk.green("ok"), `recovered after ${consecutiveFailures} failed ${consecutiveFailures === 1 ? "poll" : "polls"}`)
        consecutiveFailures = 0
      }
    } catch (err) {
      if (shuttingDown) return // Ctrl+C aborted the request mid-flight

      if (err instanceof AuthError) {
        status.log(chalk.dim(`[${timestamp}]`), chalk.red("error"), err.message)
        status.log(chalk.dim(`   Check VERCEL_TOKEN — see "Setup" in the README.`))
        return shutdown(1) // returns before the re-arm, so no timer dangles
      }

      session.errors += 1
      if (consecutiveFailures < MAX_TRACKED_FAILURES) consecutiveFailures += 1

      const message = err instanceof Error && err.name === "TimeoutError"
        ? `request timed out after ${formatDuration(timeoutMs)}`
        : err instanceof Error ? err.message : String(err)

      const delay = scheduleNext()
      status.log(chalk.dim(`[${timestamp}]`), chalk.red("error"), `${message} · retrying in ${formatDuration(delay)}`)
      return
    }

    scheduleNext()
  }

  status.start()
  await poll()
}

program.parse()
