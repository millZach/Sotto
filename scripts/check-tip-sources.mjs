// Reads the provider documentation every doc tip rests on (ADR-0159) and reports the tips whose sentence is gone.
//
//   node scripts/check-tip-sources.mjs [--report <file>]
//
// Each source in src/renderer/src/agents/tipSources.json names a page and the sentence the tip paraphrases. A page that
// no longer carries that sentence, or that answers 404 or 410, is reported: the tip may now say something untrue. A page
// that cannot be reached for any other reason is only warned about, since a provider's outage says nothing about the tip.
// With --report, a Markdown report is written when anything is reported; .github/workflows/tip-sources.yml opens an
// issue from it. Runs on GitHub's runners only; Sotto itself never fetches these pages.
import console from 'node:console'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const TIP_SOURCES_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'src', 'agents', 'tipSources.json')

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', mdash: '-', ndash: '-', hellip: '...' }

/** The words a page shows, flattened for a phrase search: no markup, entities decoded, curly quotes and dashes plain, one space between words. */
export function pageText(html) {
  return html
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/giu, ' ')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/giu, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole)
    .replace(/[‘’]/gu, "'").replace(/[“”]/gu, '"').replace(/[–—]/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** Whether the page's words carry the phrase, ignoring case and spacing. */
export function carries(text, phrase) {
  return pageText(text).toLowerCase().includes(pageText(phrase).toLowerCase())
}

/**
 * Checks every source. `fetchPage(url)` answers `{ status, text }` or throws. Returns the sources to report (`missing`
 * when the page answered without the sentence, `gone` on 404 or 410) and the ones only warned about.
 */
export async function checkTipSources(sources, fetchPage) {
  const reported = [], warned = []
  for (const [id, source] of Object.entries(sources)) {
    let page
    try { page = await fetchPage(source.url) } catch (error) {
      warned.push({ id, url: source.url, reason: error instanceof Error ? error.message : String(error) })
      continue
    }
    if (page.status === 404 || page.status === 410) reported.push({ id, ...source, reason: 'gone' })
    else if (page.status < 200 || page.status >= 300) warned.push({ id, url: source.url, reason: `HTTP ${page.status}` })
    else if (!carries(page.text, source.phrase)) reported.push({ id, ...source, reason: 'missing' })
  }
  return { reported, warned }
}

/** The issue body for what was reported. */
export function reportMarkdown(reported) {
  const rows = reported.map(item => `- \`${item.id}\` (${item.provider}): ${item.reason === 'gone' ? 'the page is gone' : 'the page no longer says'} “${item.phrase}”. ${item.url}, last checked ${item.checked}.`)
  return [
    'The weekly tip source check found provider documentation that no longer backs a tip (ADR-0159).',
    '',
    ...rows,
    '',
    'For each one, read the page again. Rewrite the tip in `src/renderer/src/agents/tips.tsx` and its phrase and checked date in `src/renderer/src/agents/tipSources.json`, or remove both. Until then the tip still shows, and may now be wrong.',
  ].join('\n')
}

async function fetchPage(url) {
  let last
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await globalThis.fetch(url, { redirect: 'follow', headers: { 'user-agent': 'Sotto tip source check (+https://github.com/millZach/Sotto)' }, signal: globalThis.AbortSignal.timeout(30_000) })
      return { status: response.status, text: await response.text() }
    } catch (error) { last = error }
  }
  throw last
}

async function main(args) {
  const reportAt = args.indexOf('--report') >= 0 ? args[args.indexOf('--report') + 1] : undefined
  const sources = JSON.parse(await readFile(TIP_SOURCES_PATH, 'utf8'))
  const { reported, warned } = await checkTipSources(sources, fetchPage)
  for (const item of warned) console.warn(`tip-source-unreachable ${item.id} ${item.url}: ${item.reason}`)
  for (const item of reported) console.log(`tip-source-changed ${item.id} ${item.url}: ${item.reason}`)
  if (reported.length && reportAt) await writeFile(reportAt, `${reportMarkdown(reported)}\n`, 'utf8')
  console.log(`Checked ${Object.keys(sources).length} tip sources: ${reported.length} changed, ${warned.length} unreachable.`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1 })
}
