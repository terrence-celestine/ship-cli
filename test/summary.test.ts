import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { formatDuration, average, tally, renderSummary, soundFor, type SessionStats, type ProjectStats } from "../ship.js"
import type { Deployment } from "../api.js"

const MIN = 60_000
const HR = 60 * MIN
const DAY = 24 * HR

describe("formatDuration", () => {
  test("sub-second collapses", () => {
    assert.equal(formatDuration(0), "< 1s")
    assert.equal(formatDuration(999), "< 1s")
  })

  test("seconds", () => {
    assert.equal(formatDuration(1000), "1s")
    assert.equal(formatDuration(47_000), "47s")
    assert.equal(formatDuration(59_000), "59s")
  })

  // The regression this function has already had once: each range must be
  // checked against the *rounded* value, or 59_600 renders as "60s".
  test("boundaries promote to the next unit instead of overflowing the label", () => {
    assert.equal(formatDuration(59_600), "1 min")
    assert.equal(formatDuration(3_599_600), "1 hr")
    assert.equal(formatDuration(86_399_600), "1 day")
  })

  test("minutes, hours, days", () => {
    assert.equal(formatDuration(MIN), "1 min")
    assert.equal(formatDuration(90_000), "2 min")
    assert.equal(formatDuration(HR), "1 hr")
    assert.equal(formatDuration(DAY), "1 day")
    assert.equal(formatDuration(2 * DAY), "2 days")
  })

  test("singular day is not pluralized", () => {
    assert.equal(formatDuration(1.4 * DAY), "1 day")
  })
})

describe("average", () => {
  test("arithmetic mean", () => {
    assert.equal(average([47_000, 47_000, 12_000, 12_000]), 29_500)
    assert.equal(average([5]), 5)
  })
})

describe("tally", () => {
  const d = (readyState: string): Deployment =>
    ({ uid: "u" + Math.random(), name: "n", url: "u", readyState, created: 0, projectId: "p" })

  test("counts by readyState", () => {
    const counts = tally([d("READY"), d("READY"), d("BUILDING")])
    assert.equal(counts.get("READY"), 2)
    assert.equal(counts.get("BUILDING"), 1)
    assert.equal(counts.get("ERROR"), undefined)
  })

  test("empty input yields an empty map", () => {
    assert.equal(tally([]).size, 0)
  })
})

const proj = (name: string, o: Partial<ProjectStats> = {}): ProjectStats =>
  ({ name, transitions: 0, successes: 0, failures: 0, durations: [], ...o })

const session = (projects: ProjectStats[], o: Partial<SessionStats> = {}): SessionStats => ({
  startedAt: 0,
  polls: 1,
  errors: 0,
  projects: new Map(projects.map((p, i) => [`prj_${i}`, p])),
  ...o,
})

describe("renderSummary", () => {
  test("no transitions yields the short form, no table", () => {
    const lines = renderSummary(session([proj("splittab")]), 41 * MIN)
    assert.equal(lines.length, 3)
    assert.match(lines[1], /Watched for 41 min · 1 poll$/)
    assert.match(lines[2], /No state changes observed\./)
    assert.ok(!lines.some(l => l.includes("avg build")), "table must be absent")
  })

  test("error count appears only when non-zero", () => {
    assert.ok(!renderSummary(session([proj("a")]), 1000)[1].includes("error"))
    assert.match(renderSummary(session([proj("a")], { errors: 1 }), 1000)[1], /· 1 error$/)
    assert.match(renderSummary(session([proj("a")], { errors: 3 }), 1000)[1], /· 3 errors$/)
  })

  test("renders a row per project, including quiet ones", () => {
    const lines = renderSummary(session([
      proj("fitlog", { transitions: 4, successes: 2, durations: [47_000, 47_000] }),
      proj("cartly", { transitions: 3, successes: 1, failures: 1, durations: [12_000, 12_000] }),
      proj("splittab"),
    ]), 41 * MIN)

    const body = lines.join("\n")
    assert.match(body, /fitlog\s+4\s+2\s+0\s+47s/)
    assert.match(body, /cartly\s+3\s+1\s+1\s+12s/)
    assert.match(body, /splittab\s+0\s+0\s+0\s+—/, "a project with no changes still gets a row")
  })

  test("footer averages across all recorded builds", () => {
    const lines = renderSummary(session([
      proj("fitlog", { transitions: 4, successes: 2, durations: [47_000, 47_000] }),
      proj("cartly", { transitions: 3, successes: 1, failures: 1, durations: [12_000, 12_000] }),
    ]), 41 * MIN)
    assert.match(lines.at(-1)!, /3 succeeded, 1 failed · avg build 30s across 4 builds$/)
  })

  test("omits the avg clause entirely when no durations were recorded", () => {
    const lines = renderSummary(session([proj("a", { transitions: 1 })]), 1000)
    const footer = lines.at(-1)!
    assert.match(footer, /0 succeeded, 0 failed$/)
    assert.ok(!footer.includes("NaN"), "must never render NaN")
    assert.ok(!footer.includes("avg build"))
  })

  test("singular build is not pluralized", () => {
    const lines = renderSummary(session([proj("a", { transitions: 1, successes: 1, durations: [1000] })]), 1000)
    assert.match(lines.at(-1)!, /across 1 build$/)
  })

  // Padding a chalk-wrapped string counts ANSI bytes as visible width. The test
  // script pins FORCE_COLOR=0 so these assertions measure real columns.
  test("columns align regardless of project-name length", () => {
    const lines = renderSummary(session([
      proj("a", { transitions: 2 }),
      proj("a-very-long-project-name", { transitions: 1 }),
    ]), 1000)

    const table = lines.filter(l => /\bchanges\b|^\s{3}a/.test(l))
    const changesColumn = table.map(l => l.indexOf("changes") >= 0 ? l.indexOf("changes") + "changes".length : null)
    assert.ok(changesColumn[0] !== null, "header row not found")

    // Every data row's first numeric column must right-align to the header's edge.
    const headerEnd = changesColumn[0]!
    for (const row of table.slice(1)) {
      assert.equal(row.length >= headerEnd, true, `row too short to align: ${JSON.stringify(row)}`)
      assert.match(row.slice(0, headerEnd), /\d$/, `changes column misaligned: ${JSON.stringify(row)}`)
    }
  })

  test("rows sort by transitions desc, then name asc", () => {
    const lines = renderSummary(session([
      proj("zeta", { transitions: 1 }),
      proj("alpha", { transitions: 1 }),
      proj("busy", { transitions: 9 }),
    ]), 1000)
    const names = lines.filter(l => /^\s{3}(zeta|alpha|busy)/.test(l)).map(l => l.trim().split(/\s+/)[0])
    assert.deepEqual(names, ["busy", "alpha", "zeta"])
  })
})

describe("soundFor", () => {
  test("keys off the outcome, not the mode", () => {
    assert.equal(soundFor("READY"), "Glass")
    assert.equal(soundFor("ERROR"), "Basso")
    assert.equal(soundFor("CANCELED"), "Pop")
  })

  test("in-flight and unknown states are not success sounds", () => {
    for (const s of ["BUILDING", "QUEUED", "INITIALIZING", "SOME_FUTURE_STATE"]) {
      assert.equal(soundFor(s), "Pop", `${s} must not claim success`)
    }
  })
})
