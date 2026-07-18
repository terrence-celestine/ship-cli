type ReadyState = "READY" | "BUILDING" | "ERROR" | "QUEUED" | "CANCELED" | "INITIALIZING" | (string & {})

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


const SIMULATED_TRANSITIONS: Deployment[][] = [
  // Poll 1: initial state
  [
    { uid: "dpl_sim_1", name: "fitlog", url: "sim", readyState: "QUEUED", created: Date.now(), projectId: "prj_1" },
    { uid: "dpl_sim_2", name: "splittab", url: "sim", readyState: "READY", created: Date.now(), projectId: "prj_2", },
    { uid: "dpl_sim_3", name: "cartly", url: "sim", readyState: "BUILDING", created: Date.now(), projectId: "prj_3" },
  ],
  // Poll 2: fitlog starts building
  [
    { uid: "dpl_sim_1", name: "fitlog", url: "sim", readyState: "BUILDING", created: Date.now(), projectId: "prj_1", buildingAt: Date.now() - 3000 },
    { uid: "dpl_sim_2", name: "splittab", url: "sim", readyState: "READY", created: Date.now(), projectId: "prj_2" },
    { uid: "dpl_sim_3", name: "cartly", url: "sim", readyState: "READY", created: Date.now(), projectId: "prj_3" },
  ],
  // Poll 3: fitlog succeeds
  [
    {
      uid: "dpl_sim_1", name: "fitlog", url: "sim", readyState: "READY", created: Date.now(), projectId: "prj_1", buildingAt: Date.now() - 47_000,
      ready: Date.now()
    },
    { uid: "dpl_sim_2", name: "splittab", url: "sim", readyState: "READY", created: Date.now(), projectId: "prj_2" },
    { uid: "dpl_sim_3", name: "cartly", url: "sim", readyState: "READY", created: Date.now(), projectId: "prj_3" },
  ],
  // Poll 4: cartly fails
  [
    { uid: "dpl_sim_1", name: "fitlog", url: "sim", readyState: "READY", created: Date.now(), projectId: "prj_1" },
    { uid: "dpl_sim_2", name: "splittab", url: "sim", readyState: "READY", created: Date.now(), projectId: "prj_2" },
    { uid: "dpl_sim_3", name: "cartly", url: "sim", readyState: "ERROR", created: Date.now(), projectId: "prj_3", buildingAt: Date.now() - 12_000, ready: Date.now() },
  ],
]

export let simulateIndex = 0

export const getSimulatedDeployments = (): Deployment[] => {
  const snapshot = SIMULATED_TRANSITIONS[simulateIndex % SIMULATED_TRANSITIONS.length]
  simulateIndex += 1
  return snapshot
}