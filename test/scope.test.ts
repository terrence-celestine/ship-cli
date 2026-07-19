import { test, describe } from "node:test"
import assert from "node:assert/strict"
import {
  teamParam, scopeFrom, matchProjects, resolveLimit,
  buildDeploymentsUrl, buildProjectsUrl, fetchAllProjects,
  MAX_PROJECT_PAGES, DEFAULT_LIMIT, MAX_LIMIT,
  type VercelProject,
} from "../scope.js"

const proj = (id: string, name: string): VercelProject => ({ id, name })

const PROJECTS = [
  proj("p1", "cartly"),
  proj("p2", "fitlog"),
  proj("p3", "splittab"),
  proj("p4", "cart-admin"),
]

describe("teamParam", () => {
  test("team_-prefixed values are ids", () => {
    assert.deepEqual(teamParam("team_abc123"), ["teamId", "team_abc123"])
  })

  test("everything else is a slug", () => {
    assert.deepEqual(teamParam("my-team"), ["slug", "my-team"])
    assert.deepEqual(teamParam("acme"), ["slug", "acme"])
  })

  test("a slug merely containing an underscore is still a slug", () => {
    assert.deepEqual(teamParam("my_team"), ["slug", "my_team"])
  })
})

describe("scopeFrom", () => {
  test("no team yields an empty scope", () => {
    assert.deepEqual(scopeFrom(undefined), {})
  })

  test("populates key and value", () => {
    assert.deepEqual(scopeFrom("acme"), { teamKey: "slug", teamValue: "acme" })
    assert.deepEqual(scopeFrom("team_x"), { teamKey: "teamId", teamValue: "team_x" })
  })
})

describe("matchProjects", () => {
  // The behavior this whole change most risks breaking.
  test("substring matching still finds cartly from cart", () => {
    const { matched, unmatched } = matchProjects(PROJECTS, ["cart"])
    assert.deepEqual(matched.map(p => p.name).sort(), ["cart-admin", "cartly"])
    assert.deepEqual(unmatched, [])
  })

  test("matching is case-insensitive against the project name", () => {
    assert.equal(matchProjects(PROJECTS, ["CARTLY".toLowerCase()]).matched.length, 1)
    assert.equal(matchProjects([proj("p", "CartLy")], ["cartly"]).matched.length, 1)
  })

  test("reports filters that matched nothing, by name", () => {
    const { matched, unmatched } = matchProjects(PROJECTS, ["fit", "nope", "alsonope"])
    assert.deepEqual(matched.map(p => p.name), ["fitlog"])
    assert.deepEqual(unmatched, ["nope", "alsonope"])
  })

  test("overlapping filters do not duplicate a project", () => {
    const { matched } = matchProjects(PROJECTS, ["cart", "cartly"])
    assert.equal(matched.filter(p => p.id === "p1").length, 1)
  })

  test("no projects means every filter is unmatched", () => {
    const { matched, unmatched } = matchProjects([], ["cart"])
    assert.deepEqual(matched, [])
    assert.deepEqual(unmatched, ["cart"])
  })
})

describe("resolveLimit", () => {
  test("explicit wins and is clamped to 1..100", () => {
    assert.equal(resolveLimit({ explicit: 50 }), 50)
    assert.equal(resolveLimit({ explicit: 500 }), MAX_LIMIT)
    assert.equal(resolveLimit({ explicit: 0 }), 1)
    assert.equal(resolveLimit({ explicit: 7, matchedProjectCount: 30 }), 7)
  })

  test("unfiltered falls back to the API default, not the old hardcoded 5", () => {
    assert.equal(resolveLimit({}), DEFAULT_LIMIT)
    assert.equal(resolveLimit({ matchedProjectCount: 0 }), DEFAULT_LIMIT)
    assert.notEqual(resolveLimit({}), 5)
  })

  test("scales with matched projects but never below the default or above the max", () => {
    assert.equal(resolveLimit({ matchedProjectCount: 1 }), DEFAULT_LIMIT)
    assert.equal(resolveLimit({ matchedProjectCount: 6 }), 30)
    assert.equal(resolveLimit({ matchedProjectCount: 100 }), MAX_LIMIT)
  })
})

describe("buildDeploymentsUrl", () => {
  const parse = (url: string) => new URL(url)

  test("unscoped, unfiltered", () => {
    const u = parse(buildDeploymentsUrl({ limit: 20, scope: {} }))
    assert.equal(u.pathname, "/v6/deployments")
    assert.equal(u.searchParams.get("limit"), "20")
    assert.equal(u.searchParams.get("slug"), null)
    assert.equal(u.searchParams.get("projectIds"), null)
  })

  test("team slug and team id land in the right parameter", () => {
    assert.equal(parse(buildDeploymentsUrl({ limit: 20, scope: scopeFrom("acme") })).searchParams.get("slug"), "acme")
    assert.equal(parse(buildDeploymentsUrl({ limit: 20, scope: scopeFrom("team_x") })).searchParams.get("teamId"), "team_x")
  })

  test("projectIds are comma-separated", () => {
    const u = parse(buildDeploymentsUrl({ limit: 20, scope: {}, projectIds: ["p1", "p2"] }))
    assert.equal(u.searchParams.get("projectIds"), "p1,p2")
  })

  test("an empty projectIds array is omitted, not sent blank", () => {
    assert.equal(parse(buildDeploymentsUrl({ limit: 20, scope: {}, projectIds: [] })).searchParams.get("projectIds"), null)
  })

  test("scope and filter combine", () => {
    const u = parse(buildDeploymentsUrl({ limit: 40, scope: scopeFrom("acme"), projectIds: ["p1"] }))
    assert.equal(u.searchParams.get("limit"), "40")
    assert.equal(u.searchParams.get("slug"), "acme")
    assert.equal(u.searchParams.get("projectIds"), "p1")
  })

  test("a team value needing encoding is escaped", () => {
    const u = parse(buildDeploymentsUrl({ limit: 20, scope: scopeFrom("a team/x") }))
    assert.equal(u.searchParams.get("slug"), "a team/x")
    assert.ok(!u.search.includes(" "), "raw space must not reach the query string")
  })
})

describe("buildProjectsUrl", () => {
  test("defaults to a full page and carries the cursor", () => {
    const u = new URL(buildProjectsUrl({ scope: {} }))
    assert.equal(u.pathname, "/v10/projects")
    assert.equal(u.searchParams.get("limit"), "100")
    assert.equal(u.searchParams.get("until"), null)

    assert.equal(new URL(buildProjectsUrl({ scope: {}, until: 1234 })).searchParams.get("until"), "1234")
  })

  test("is scoped like the deployments url", () => {
    assert.equal(new URL(buildProjectsUrl({ scope: scopeFrom("acme") })).searchParams.get("slug"), "acme")
  })
})

// A fetch stub: hands back one page per call, recording the urls requested.
const stubFetch = (pages: { projects: VercelProject[]; next?: number | null }[]) => {
  const calls: string[] = []
  let i = 0
  const impl = (async (url: string | URL) => {
    calls.push(String(url))
    const page = pages[Math.min(i++, pages.length - 1)]
    return {
      ok: true,
      status: 200,
      json: async () => ({ projects: page.projects, pagination: { next: page.next ?? null } }),
    } as unknown as Response
  }) as unknown as typeof fetch
  return { impl, calls }
}

const failingFetch = (status: number) => (async () => ({
  ok: false,
  status,
  json: async () => ({}),
}) as unknown as Response) as unknown as typeof fetch

describe("fetchAllProjects", () => {
  test("returns a single page without paginating", async () => {
    const { impl, calls } = stubFetch([{ projects: PROJECTS }])
    const { projects, truncated } = await fetchAllProjects({ token: "t", scope: {} }, impl)
    assert.equal(projects.length, 4)
    assert.equal(truncated, false)
    assert.equal(calls.length, 1)
  })

  test("follows the cursor and concatenates pages", async () => {
    const { impl, calls } = stubFetch([
      { projects: [proj("p1", "a")], next: 111 },
      { projects: [proj("p2", "b")], next: 222 },
      { projects: [proj("p3", "c")], next: null },
    ])
    const { projects, truncated } = await fetchAllProjects({ token: "t", scope: {} }, impl)
    assert.deepEqual(projects.map(p => p.id), ["p1", "p2", "p3"])
    assert.equal(truncated, false)
    assert.equal(calls.length, 3)
    assert.ok(calls[1].includes("until=111"), `cursor not carried: ${calls[1]}`)
    assert.ok(calls[2].includes("until=222"), `cursor not carried: ${calls[2]}`)
  })

  test("stops at the page cap and reports truncation rather than looping forever", async () => {
    // Always returns a next cursor — without the cap this never terminates.
    const { impl, calls } = stubFetch([{ projects: [proj("p", "x")], next: 1 }])
    const { projects, truncated } = await fetchAllProjects({ token: "t", scope: {} }, impl)
    assert.equal(calls.length, MAX_PROJECT_PAGES)
    assert.equal(projects.length, MAX_PROJECT_PAGES)
    assert.equal(truncated, true)
  })

  test("sends the bearer token and the team scope", async () => {
    const calls: RequestInit[] = []
    const impl = (async (url: string | URL, init?: RequestInit) => {
      calls.push(init ?? {})
      assert.ok(String(url).includes("slug=acme"))
      return { ok: true, status: 200, json: async () => ({ projects: [], pagination: { next: null } }) } as unknown as Response
    }) as unknown as typeof fetch

    await fetchAllProjects({ token: "secret", scope: scopeFrom("acme") }, impl)
    assert.equal((calls[0].headers as Record<string, string>).Authorization, "Bearer secret")
  })

  test("404 is reported as an unknown team, naming it", async () => {
    await assert.rejects(
      () => fetchAllProjects({ token: "t", scope: scopeFrom("nope") }, failingFetch(404)),
      /No such team "nope"/,
    )
  })

  test("403 names the team so the fix is obvious", async () => {
    await assert.rejects(
      () => fetchAllProjects({ token: "t", scope: scopeFrom("acme") }, failingFetch(403)),
      /team "acme".*403/s,
    )
  })

  test("a non-team failure still surfaces the status", async () => {
    await assert.rejects(
      () => fetchAllProjects({ token: "t", scope: {} }, failingFetch(500)),
      /Could not list projects — Vercel API: 500/,
    )
  })

  test("a response missing the projects key does not throw", async () => {
    const impl = (async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch
    const { projects } = await fetchAllProjects({ token: "t", scope: {} }, impl)
    assert.deepEqual(projects, [])
  })
})
