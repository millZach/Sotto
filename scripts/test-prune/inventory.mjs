// Lists every Vitest case under tests/ with what the prune rubric needs beside the code: its CI time on
// a passing main run, CI failures on main, issue and ADR references, timer use, and the keep rule that
// covers it, if any. node inventory.mjs <repo> <ci dir> <out.json>
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import process from 'node:process'
import { findCases, parse } from './cases.mjs'

const [repo, ciDir, outPath] = process.argv.slice(2)
const walk = dir => readdirSync(dir).flatMap(name => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? walk(path) : [path]
})
const files = walk(join(repo, 'tests')).map(p => relative(repo, p).replaceAll('\\', '/'))
  .filter(p => /\.(test|spec)\.[cm]?[jt]sx?$/u.test(p))

// CI times from one passing main run: [file, "suite > ... > title", winMs, linuxMs]
const timed = JSON.parse(readFileSync(join(ciDir, 'test_times.json'), 'utf8'))
const timesByFile = new Map()
for (const [file, name, win, linux] of timed) {
  if (!timesByFile.has(file)) timesByFile.set(file, [])
  timesByFile.get(file).push({ name, win: win ?? 0, linux: linux ?? 0, used: false })
}
const failures = JSON.parse(readFileSync(join(ciDir, 'failures.json'), 'utf8')) // {file: {title: count}}
const flakeIssues = JSON.parse(readFileSync(join(ciDir, 'flake_files.json'), 'utf8'))
const issuesByFile = new Map()
for (const [number, issue] of Object.entries(flakeIssues)) for (const f of issue.files) {
  if (!issuesByFile.has(f)) issuesByFile.set(f, [])
  issuesByFile.get(f).push({ number: Number(number), state: issue.state, title: issue.title })
}

// Documents whose naming a test file keeps it whole (AGENTS.md and docs/ci.md), and the npm scripts.
const naming = ['AGENTS.md', 'docs/ci.md', 'package.json'].map(p => readFileSync(join(repo, p), 'utf8')).join('\n')
const otherDocs = walk(join(repo, 'docs')).filter(p => p.endsWith('.md')).map(p => [relative(repo, p), readFileSync(p, 'utf8')])

const unquote = text => text.replace(/^['"`]|['"`]$/gu, '')
const pattern = title => {
  const raw = unquote(title)
  const parts = raw.split(/\$\{[^}]*\}|%[sdifjoO#%]|\$[\w.]+/u)
  return parts.map(p => p.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\\\\'/gu, "'")).join('.*')
}

// Paths whose tests the brief keeps regardless of a model's verdict, and paths that are sensitive enough
// for two independent passes. Matched against the file path, case-insensitively.
const KEEP_FILE = [
  /^tests\/perf\//, /^tests\/e2e\//, /^tests\/unit\/release\//, /^tests\/unit\/scripts\//,
  /adapterContract/, /hostServiceContract/, /copySites/, /themeTokens/, /interfaceCatalogs/, /suiteWaitDeadline/,
  /gitGuard/, /trackedFileEncoding/, /testDiscovery/, /shardSequencer/,
]
const SENSITIVE = /adapter|provider|claude|codex|grok|devin|muse|opencode|cursor|acp|rpc|protocol|socket|host|pair|wire|frame|permission|sandbox|auth|credential|secret|key|token|grant|policy|approval|request|store|persist|migrat|database|sqlite|journal|ledger|archive|history|save|disk|atomic|git|worktree|checkpoint|branch|commit|merge|rebase|bringChanges|reclaim|watcher|settle|news|race|concurren|lock|receipt|uncertain|recovery|composer|scene|owl|privacy|log|redact/i

const records = []
for (const file of files) {
  const text = readFileSync(join(repo, file), 'utf8')
  let source
  try { source = parse(file, text) } catch { continue }
  const cases = findCases(source)
  const times = timesByFile.get(file) ?? []
  const fileFails = failures[file] ?? {}
  const keepFile = KEEP_FILE.some(r => r.test(file)) || naming.includes(file) || naming.includes(file.split('/').pop())
  const citedBy = otherDocs.filter(([, body]) => body.includes(file) || body.includes(file.split('/').pop())).map(([p]) => p)
  const fileTimers = { fake: /vi\.useFakeTimers|useFakeTimers\(/u.test(text), real: /new Promise\(\s*\w+\s*=>\s*setTimeout|\bsleep\(|\bdelay\(\s*\d/u.test(text) }
  const caseRecords = []
  for (const c of cases.filter(x => x.type === 'case')) {
    const re = new RegExp('^' + [...c.suites, c.title].map(pattern).join(' > ') + '(\\s|$)', 'u')
    const matched = times.filter(t => re.test(t.name))
    for (const t of matched) t.used = true
    const body = text.slice(c.start, c.end)
    const refText = c.title + '\n' + c.leadingComments
    const refs = [...new Set([...refText.matchAll(/#(\d{2,5})\b|ADR-?(\d{3,4})/giu)].map(m => m[1] ? `#${m[1]}` : `ADR-${m[2]}`))]
    const failCount = Object.entries(fileFails).filter(([title]) => title && re.test(title) || title.endsWith(unquote(c.title).slice(0, 60))).reduce((a, [, n]) => a + n, 0)
    caseRecords.push({
      suites: c.suites, title: c.title, occurrence: c.occurrence, modifiers: c.modifiers, dynamic: c.dynamic, deletable: c.deletable,
      line: c.line, lines: c.endLine - c.line + 1,
      winMs: matched.reduce((a, t) => a + t.win, 0), linuxMs: matched.reduce((a, t) => a + t.linux, 0), runs: matched.length,
      refs, ciFailures: failCount,
      fakeTimers: /useFakeTimers|advanceTimers|runAllTimers|runOnlyPendingTimers/u.test(body),
      realWaits: /new Promise\(\s*\(?\w*\)?\s*=>\s*setTimeout|\bsleep\(|\bdelay\(\s*\d|setTimeout\([^,]+,\s*[1-9]\d{2,}/u.test(body),
    })
  }
  records.push({
    file, lines: text.split('\n').length, cases: caseRecords.length,
    winMs: times.reduce((a, t) => a + t.win, 0), linuxMs: times.reduce((a, t) => a + t.linux, 0),
    unmatchedMs: times.filter(t => !t.used).reduce((a, t) => a + t.win, 0),
    keepFile, citedBy, sensitive: SENSITIVE.test(file), timers: fileTimers,
    flakeIssues: issuesByFile.get(file) ?? [], ciFailures: Object.values(fileFails).reduce((a, n) => a + n, 0),
    caseList: caseRecords,
  })
}
writeFileSync(outPath, JSON.stringify(records))
const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0)
process.stdout.write(`${records.length} files, ${sum(records, r => r.cases)} cases, ${Math.round(sum(records, r => r.winMs) / 60000)} Windows test-minutes, ${Math.round(sum(records, r => r.unmatchedMs) / 60000)} unmatched\n`)
