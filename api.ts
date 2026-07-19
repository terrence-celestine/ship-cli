export type ReadyState = "READY" | "BUILDING" | "ERROR" | "QUEUED" | "CANCELED" | "INITIALIZING" | (string & {})

export interface Deployment {
  uid: string
  name: string
  url: string
  readyState: ReadyState
  created: number
  projectId: string;
  ready?: number;
  buildingAt?: number;
}

/**
 * States a deployment stops at. Membership is tested positively on purpose —
 * `ReadyState` has a `(string & {})` arm, so a negation like `!== "BUILDING"`
 * would treat every future Vercel state as terminal.
 */
const TERMINAL_STATES = new Set<string>(["READY", "ERROR", "CANCELED"])

export const isTerminalState = (state: ReadyState): boolean => TERMINAL_STATES.has(state)

// A deployment's URL is stable across polls, so each uid keeps its own hostname.
// `obrien` carries a quote, a double quote and a trailing backslash so that
// --simulate actually exercises the AppleScript escaping in notify.ts.
const OBRIEN = `o'brien "test"\\`

const SIMULATED_TRANSITIONS: Deployment[][] = [
  // Poll 1: initial state
  [
    { uid: "dpl_sim_1", name: "fitlog", url: "fitlog-sim1.vercel.app", readyState: "QUEUED", created: Date.now(), projectId: "prj_1" },
    { uid: "dpl_sim_2", name: "splittab", url: "splittab-sim2.vercel.app", readyState: "READY", created: Date.now(), projectId: "prj_2", },
    { uid: "dpl_sim_3", name: "cartly", url: "cartly-sim3.vercel.app", readyState: "BUILDING", created: Date.now(), projectId: "prj_3" },
    { uid: "dpl_sim_4", name: OBRIEN, url: "obrien-sim4.vercel.app", readyState: "QUEUED", created: Date.now(), projectId: "prj_4" },
  ],
  // Poll 2: fitlog starts building
  [
    { uid: "dpl_sim_1", name: "fitlog", url: "fitlog-sim1.vercel.app", readyState: "BUILDING", created: Date.now(), projectId: "prj_1", buildingAt: Date.now() - 3000 },
    { uid: "dpl_sim_2", name: "splittab", url: "splittab-sim2.vercel.app", readyState: "READY", created: Date.now(), projectId: "prj_2" },
    { uid: "dpl_sim_3", name: "cartly", url: "cartly-sim3.vercel.app", readyState: "READY", created: Date.now(), projectId: "prj_3" },
    { uid: "dpl_sim_4", name: OBRIEN, url: "obrien-sim4.vercel.app", readyState: "QUEUED", created: Date.now(), projectId: "prj_4" },
  ],
  // Poll 3: fitlog succeeds, o'brien is canceled
  [
    {
      uid: "dpl_sim_1", name: "fitlog", url: "fitlog-sim1.vercel.app", readyState: "READY", created: Date.now(), projectId: "prj_1", buildingAt: Date.now() - 47_000,
      ready: Date.now()
    },
    { uid: "dpl_sim_2", name: "splittab", url: "splittab-sim2.vercel.app", readyState: "READY", created: Date.now(), projectId: "prj_2" },
    { uid: "dpl_sim_3", name: "cartly", url: "cartly-sim3.vercel.app", readyState: "READY", created: Date.now(), projectId: "prj_3" },
    { uid: "dpl_sim_4", name: OBRIEN, url: "obrien-sim4.vercel.app", readyState: "CANCELED", created: Date.now(), projectId: "prj_4" },
  ],
  // Poll 4: cartly fails
  [
    { uid: "dpl_sim_1", name: "fitlog", url: "fitlog-sim1.vercel.app", readyState: "READY", created: Date.now(), projectId: "prj_1" },
    { uid: "dpl_sim_2", name: "splittab", url: "splittab-sim2.vercel.app", readyState: "READY", created: Date.now(), projectId: "prj_2" },
    { uid: "dpl_sim_3", name: "cartly", url: "cartly-sim3.vercel.app", readyState: "ERROR", created: Date.now(), projectId: "prj_3", buildingAt: Date.now() - 12_000, ready: Date.now() },
    { uid: "dpl_sim_4", name: OBRIEN, url: "obrien-sim4.vercel.app", readyState: "CANCELED", created: Date.now(), projectId: "prj_4" },
  ],
]

export let simulateIndex = 0

export const getSimulatedDeployments = (): Deployment[] => {
  const snapshot = SIMULATED_TRANSITIONS[simulateIndex % SIMULATED_TRANSITIONS.length]
  simulateIndex += 1
  return snapshot
}
