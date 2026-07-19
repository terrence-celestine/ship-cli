import readline from "node:readline"
import chalk from "chalk"

export interface StatusLine {
  readonly enabled: boolean
  start(): void
  stop(): void
  clear(): void
  setNextPollAt(ts: number | null): void
  setTallies(tallies: Map<string, number>): void
  log(...args: unknown[]): void
}

// Fixed render order so counts don't jump position between ticks.
const STATE_ORDER = ["READY", "BUILDING", "QUEUED", "ERROR"]

const STATE_COLORS: Record<string, (s: string) => string> = {
  READY: chalk.green,
  BUILDING: chalk.yellow,
  QUEUED: chalk.dim,
  ERROR: chalk.red,
}

/**
 * A single rewriting line pinned to the bottom of the terminal.
 *
 * Disabled entirely when stdout isn't a TTY, so redirected or piped output
 * stays byte-identical to what the plain console.log calls would produce.
 * Note that readline.cursorTo/clearLine do NOT check isTTY themselves — the
 * `enabled` gate is what keeps escape codes out of files.
 */
export function createStatusLine(): StatusLine {
  const enabled = Boolean(process.stdout.isTTY)

  let ticker: NodeJS.Timeout | null = null
  let nextPollAt: number | null = null
  let tallies: Map<string, number> = new Map()
  let drawn = false

  const clear = (): void => {
    if (!enabled || !drawn) return
    readline.cursorTo(process.stdout, 0)
    readline.clearLine(process.stdout, 0)
    drawn = false
  }

  // Composed twice on purpose: the plain copy is what we measure and truncate
  // against, since slicing the colored copy would cut an ANSI escape in half.
  const compose = (): { plain: string; colored: string } => {
    const plain: string[] = []
    const colored: string[] = []

    const states = [
      ...STATE_ORDER.filter(s => tallies.has(s)),
      ...[...tallies.keys()].filter(s => !STATE_ORDER.includes(s)).sort(),
    ]

    for (const state of states) {
      const text = `${tallies.get(state) ?? 0} ${state.toLowerCase()}`
      plain.push(text)
      colored.push((STATE_COLORS[state] ?? chalk.dim)(text))
    }

    if (nextPollAt === null) {
      plain.push("polling…")
      colored.push(chalk.dim("polling…"))
    } else {
      // Clamp at 0 so a tick landing after the deadline but before the poll
      // fires doesn't flash a negative number.
      const secs = Math.max(0, Math.ceil((nextPollAt - Date.now()) / 1000))
      const text = `next poll in ${secs}s`
      plain.push(text)
      colored.push(chalk.dim(text))
    }

    return { plain: plain.join(" · "), colored: colored.join(chalk.dim(" · ")) }
  }

  const render = (): void => {
    if (!enabled) return
    if (nextPollAt === null && tallies.size === 0) return // nothing to say yet

    const { plain, colored } = compose()
    // Over-wide lines soft-wrap to a second row, and clearLine only clears one
    // — that orphans a fragment in the scrollback permanently.
    const width = (process.stdout.columns ?? 80) - 1

    clear()
    process.stdout.write(plain.length <= width ? colored : chalk.dim(plain.slice(0, width)))
    drawn = true
  }

  return {
    enabled,

    start(): void {
      if (!enabled || ticker) return
      ticker = setInterval(render, 1000)
      ticker.unref() // must never be the thing holding the process open
    },

    stop(): void {
      if (ticker) {
        clearInterval(ticker)
        ticker = null
      }
      clear()
    },

    clear,

    setNextPollAt(ts: number | null): void {
      nextPollAt = ts
      render()
    },

    setTallies(next: Map<string, number>): void {
      tallies = next
    },

    // Every log inside the poll loop goes through here: clear, print, redraw.
    log(...args: unknown[]): void {
      clear()
      console.log(...args)
      render()
    },
  }
}
