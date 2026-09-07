import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * What may be scheduled on the hosted deployment, and what may not.
 *
 * This exists because a cron Vercel will not accept does not degrade — it
 * rejects the entire deployment. 9.9.0 added an every-fifteen-minutes sweep and
 * the published API stayed at 9.8.0 through four releases as a result, while
 * every required check stayed green.
 *
 * So the rule is pinned in a test rather than left to memory.
 */
const vercelConfig = JSON.parse(
  readFileSync(join(process.cwd(), "vercel.json"), "utf8"),
) as { crons?: { path: string; schedule: string }[] }

const crons = vercelConfig.crons ?? []

/** Any of the five cron fields being other than "*" or a plain number means sub-daily. */
function isSubDaily(schedule: string): boolean {
  const [minute, hour] = schedule.trim().split(/\s+/)
  const fixed = (field: string) => /^\d+$/.test(field)
  return !(fixed(minute) && fixed(hour))
}

describe("vercel.json crons", () => {
  it("schedules nothing more often than once a day", () => {
    const subDaily = crons.filter(cron => isSubDaily(cron.schedule))
    expect(subDaily, [
      "Vercel rejects the whole deployment on a plan without sub-daily crons.",
      "Nothing is published while such an entry is here -- see",
      "src/app/v1/internal/close-expired-cases/route.ts.",
    ].join(" ")).toEqual([])
  })

  /**
   * Named specifically, because this is the one somebody will reach for: the
   * closure sweep genuinely wants to run every few minutes, and reading the
   * route makes that obvious while the reason it cannot live here is not. It
   * is scheduled on the appliance instead, in infra/delivery/worker-loop.sh.
   */
  it("does not schedule the case-closure sweep, which the appliance runs", () => {
    expect(crons.map(cron => cron.path)).not.toContain("/v1/internal/close-expired-cases")
  })

  // The two that remain are both nightly, and both are real obligations rather
  // than conveniences -- so a silent disappearance would matter as much as a
  // silent addition.
  it("still schedules the nightly retention purge and export processing", () => {
    expect(crons.map(cron => cron.path).sort()).toEqual([
      "/v1/internal/purge-deleted",
      "/v1/internal/research-exports/process",
    ])
  })
})
