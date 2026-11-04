import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * An end-to-end run never contacts another computer. A teammate's answer to `read-desk` comes from `e2e-team-desk.json` in the
 * run's own profile, read on each press so a spec can change it. Without the file, the teammate's computer does not answer.
 */
export function e2eTeamFetch(profile: string): typeof fetch {
  return (async (_input, init) => {
    if (JSON.parse(String(init?.body)).command !== 'read-desk') throw new Error('Not answered in an end-to-end run.')
    return new Response(readFileSync(join(profile, 'e2e-team-desk.json'), 'utf8'), { status: 200 })
  }) as typeof fetch
}
