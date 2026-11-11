/**
 * Compares two runs of `tests/e2e/launch-time.spec.ts` for `.github/workflows/launch-time.yml` and prints a Markdown
 * table: each figure's median and range on the base and on the change, and the change's median over the base's. A side
 * is read from `<side>.json`, which the spec writes when `SOTTO_LAUNCH_OUT` names it, or else from the `LAUNCH-TIME`
 * line in `<side>.log`, which a spec from before that variable prints too. A side with neither is left blank.
 *
 *   node scripts/launch-time-compare.mjs <folder holding before.* and after.*>
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const PREFIX = 'LAUNCH-TIME '

/** The JSON object after `LAUNCH-TIME ` in a run's output, or the whole text when it is the JSON itself. */
export function parseLaunchResult(text) {
  const at = text.indexOf(PREFIX)
  const body = at < 0 ? text : text.slice(at + PREFIX.length)
  const start = body.indexOf('{')
  if (start < 0) return null
  let depth = 0
  for (let index = start; index < body.length; index++) {
    if (body[index] === '{') depth++
    else if (body[index] === '}' && --depth === 0) return JSON.parse(body.slice(start, index + 1))
  }
  return null
}

export function readSide(folder, side) {
  for (const name of [`${side}.json`, `${side}.log`]) {
    const path = join(folder, name)
    if (!existsSync(path)) continue
    const result = parseLaunchResult(readFileSync(path, 'utf8'))
    if (result) return result
  }
  return null
}

const number = value => value.toLocaleString('en-US', { maximumFractionDigits: 1 })
const cell = entry => entry === undefined ? '-' : `${number(entry.median)} (${number(entry.min)} to ${number(entry.max)})${entry.runs === undefined ? '' : `, ${entry.runs} runs`}`

export function compareLaunches(before, after) {
  const beforeSummary = before?.summary ?? {}
  const afterSummary = after?.summary ?? {}
  const keys = [...new Set([...Object.keys(afterSummary), ...Object.keys(beforeSummary)])]
  const runs = side => side === null ? 'not measured' : `${side.runs} launches`
  const lines = [
    `Base: ${runs(before)}. Change: ${runs(after)}. Each after one launch to warm the disk, on an empty profile.`,
    'Median (lowest to highest). Times are milliseconds; a `mark:` row is the time since main\'s clock started.',
    '',
    '| | Base | Change | Change / base |',
    '|---|---:|---:|---:|',
  ]
  for (const key of keys) {
    const was = beforeSummary[key]
    const now = afterSummary[key]
    const ratio = was !== undefined && now !== undefined && was.median > 0 ? (now.median / was.median).toFixed(2) : '-'
    lines.push(`| ${key} | ${cell(was)} | ${cell(now)} | ${ratio} |`)
  }
  return `${lines.join('\n')}\n`
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const folder = process.argv[2]
  if (!folder) throw new Error('Name the folder that holds before.json or before.log, and after.json or after.log.')
  process.stdout.write(compareLaunches(readSide(folder, 'before'), readSide(folder, 'after')))
}
