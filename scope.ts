import { VERCEL_API_BASE, DEPLOYMENTS_PATH, PROJECTS_PATH } from "./api.js"

/** Vercel accepts either a team id or a team slug; we never need to resolve one to the other. */
export interface Scope {
  teamKey?: "teamId" | "slug"
  teamValue?: string
}

export interface VercelProject {
  id: string
  name: string
}

/**
 * Beyond this many matched projects we stop sending `projectIds` and fall back
 * to client-side filtering. An undocumented server-side cap that silently
 * truncates would be worse than a degrade we can warn about.
 */
export const MAX_PROJECT_IDS = 20

/** Startup pagination has to terminate; an unbounded loop here is a hang. */
export const MAX_PROJECT_PAGES = 5
export const PROJECTS_PAGE_SIZE = 100

/** The API's own default. The previous hardcoded 5 was below even this. */
export const DEFAULT_LIMIT = 20
export const MAX_LIMIT = 100

/**
 * Team ids are `team_`-prefixed and slugs cannot contain `_` in that position,
 * so the shape is unambiguous and `--team` accepts whichever the user has.
 */
export const teamParam = (value: string): ["teamId" | "slug", string] =>
  value.startsWith("team_") ? ["teamId", value] : ["slug", value]

export const scopeFrom = (team?: string): Scope => {
  if (!team) return {}
  const [teamKey, teamValue] = teamParam(team)
  return { teamKey, teamValue }
}

/**
 * The same case-insensitive substring predicate the deployment filter uses —
 * deliberately shared so the two can't drift. Matching now runs against the
 * full project list rather than whichever deployments happened to be recent.
 */
export const matchProjects = (
  projects: VercelProject[],
  filters: string[],
): { matched: VercelProject[]; unmatched: string[] } => {
  const matched = new Map<string, VercelProject>()
  const unmatched: string[] = []

  for (const filter of filters) {
    const hits = projects.filter(p => p.name.toLowerCase().includes(filter))
    if (hits.length === 0) unmatched.push(filter)
    for (const hit of hits) matched.set(hit.id, hit)
  }

  return { matched: [...matched.values()], unmatched }
}

/**
 * A single project can have several deployments in flight at once (preview,
 * production, a rebuild), so a flat window starves the tail once several
 * projects are scoped.
 */
export const resolveLimit = (
  { explicit, matchedProjectCount }: { explicit?: number; matchedProjectCount?: number },
): number => {
  if (explicit !== undefined) return Math.min(MAX_LIMIT, Math.max(1, explicit))
  if (!matchedProjectCount) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(DEFAULT_LIMIT, 5 * matchedProjectCount))
}

const withScope = (params: URLSearchParams, scope: Scope): void => {
  if (scope.teamKey && scope.teamValue) params.set(scope.teamKey, scope.teamValue)
}

export const buildDeploymentsUrl = (
  { limit, scope, projectIds, base = VERCEL_API_BASE }:
    { limit: number; scope: Scope; projectIds?: string[]; base?: string },
): string => {
  const params = new URLSearchParams({ limit: String(limit) })
  withScope(params, scope)
  // Comma-separated is Vercel's convention for the plural form. If it were ever
  // ignored we'd widen rather than narrow the result set, which is why the
  // caller keeps its client-side filter as a backstop.
  if (projectIds?.length) params.set("projectIds", projectIds.join(","))
  return `${base}${DEPLOYMENTS_PATH}?${params}`
}

export const buildProjectsUrl = (
  { scope, limit = PROJECTS_PAGE_SIZE, until, base = VERCEL_API_BASE }:
    { scope: Scope; limit?: number; until?: number; base?: string },
): string => {
  const params = new URLSearchParams({ limit: String(limit) })
  withScope(params, scope)
  if (until !== undefined) params.set("until", String(until))
  return `${base}${PROJECTS_PATH}?${params}`
}

interface ProjectsResponse {
  projects?: VercelProject[]
  pagination?: { next?: number | null }
}

/**
 * Enumerate the account's (or team's) projects so `--filter` can be resolved to
 * exact ids. `fetchImpl` is the codebase's only injection point — it exists so
 * pagination, the page cap and the error paths are testable without a network.
 */
export async function fetchAllProjects(
  { token, scope, signal }: { token: string; scope: Scope; signal?: AbortSignal },
  fetchImpl: typeof fetch = fetch,
): Promise<{ projects: VercelProject[]; truncated: boolean }> {
  const projects: VercelProject[] = []
  let until: number | undefined
  let pages = 0

  while (pages < MAX_PROJECT_PAGES) {
    const res = await fetchImpl(buildProjectsUrl({ scope, until }), {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    })

    if (!res.ok) {
      const scoped = scope.teamValue ? ` for team "${scope.teamValue}"` : ""
      if (res.status === 404) throw new Error(`No such team${scoped ? ` "${scope.teamValue}"` : ""} (404)`)
      throw new Error(`Could not list projects${scoped} — Vercel API: ${res.status}`)
    }

    const data = await res.json() as ProjectsResponse
    projects.push(...(data.projects ?? []))
    pages += 1

    const next = data.pagination?.next
    if (next === undefined || next === null) return { projects, truncated: false }
    until = next
  }

  return { projects, truncated: true }
}
