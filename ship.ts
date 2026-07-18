#!/usr/bin/env -S npx tsx

import { Command } from "commander"
import chalk from "chalk"
import { notify } from "./notify.js"
import { Deployment, getSimulatedDeployments } from "./api.js"

const MS_PER_MIN = 60_000;
const MS_PER_HR = 60 * MS_PER_MIN;
const MS_PER_DAY = 24 * MS_PER_HR;

const program = new Command()

program
  .name("ship")
  .description("Watch for vercel deployment changes and notify on change")
  .version("0.1.0")
  .option("-i, --interval <seconds>", "polling interval in seconds", "60")
  .option("--simulate", "use fake weather data that cycles through conditions")
  .action(async (options: { interval: string; simulate?: boolean }) => {
    const intervalSec = Number(options.interval)

    if (Number.isNaN(intervalSec) || intervalSec < 5) {
      console.error(chalk.red(`Interval must be a number >= 5 seconds. Got: ${options.interval}`))
      process.exit(1)
    }

    await runWatchLoop(intervalSec, options.simulate ?? false)
  })

const formatDuration = (ms: number): string => {
  if (ms < 1000) return "< 1s"
  if (ms < MS_PER_MIN) return `${Math.round(ms / 1000)}s`; // time is less than 1 min
  if (ms < MS_PER_HR) return `${Math.round(ms / MS_PER_MIN)} min`; // time is less than 1 hour
  if (ms < MS_PER_DAY) return `${Math.round(ms / MS_PER_HR)} hr`; // time is less than a full day
  return `${Math.round(ms / MS_PER_DAY)} days` // time is in days
}

async function runWatchLoop(intervalSec: number, simulate: boolean): Promise<void> {
  console.log(chalk.bold(`👀 Watching Vercel Deployments`))
  console.log(chalk.dim(`   Polling every ${intervalSec}s · Ctrl+C to stop`))
  console.log()

  let lastStates: Map<string, string> = new Map();
  let pollCount = 0

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log()
    console.log(chalk.dim(`✋ Stopped after ${pollCount} polls.`))
    process.exit(0)
  })

  const poll = async (): Promise<void> => {
    pollCount += 1
    const timestamp = new Date().toLocaleTimeString()

    try {
      let deployments: Deployment[];

      if (simulate) {
        deployments = getSimulatedDeployments()
      } else {
        const res = await fetch("https://api.vercel.com/v6/deployments?limit=5", { headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` } })
        if (!res.ok) throw new Error(`Vercel API: ${res.status}`)
        const data = await res.json() as { deployments: Deployment[] }
        deployments = data.deployments
      }
      if (pollCount === 1) {
        const projectCount = new Set(deployments.map(d => d.projectId)).size
        console.log(chalk.dim(`[${timestamp}]`), chalk.cyan("watching"), `${deployments.length} deployments across ${projectCount} projects`)
      }

      for (const d of deployments) {
        const previous = lastStates.get(d.uid); // look up the deployment by the UID
        if (previous !== undefined && previous !== d.readyState) {
          let message = `${previous} -> ${d.readyState}`
          // state change has occurred
          if (d.readyState === "READY" && d.buildingAt && d.ready) {
            const duration = d.ready - d.buildingAt;
            message += `(${formatDuration(duration)})`
          }

          // we found the deployment but the ready states dont match, a change occured
          console.log(
            chalk.dim(`[${timestamp}]`),
            chalk.yellow("change"),
            `${d.name} : ${message}`
          )
          const sound = d.readyState === "ERROR" ? "Basso" : "Glass";
          notify(`State changed in ${d.name}`, message, sound)
        } else {
          // no changes
        }
        lastStates.set(d.uid, d.readyState); // set the deployment by UID
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.log(chalk.dim(`[${timestamp}]`), chalk.red("error"), message)
    }

    setTimeout(poll, intervalSec * 1000)
  }

  await poll()
}

program.parse()