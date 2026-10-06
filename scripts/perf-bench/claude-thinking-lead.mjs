// How much sooner a Claude turn shows its first sign when thinking shows from its first byte (#768).
//
// Reads Claude Code's own transcripts and reports durations only: no prompt, reply or thinking text is read
// into the output. For each prompt it finds the first block the model wrote in reply on the main chain, and
// reports the wait from the prompt to that block finishing (when Sotto showed something before thinking was
// shown) and to that block starting (when it shows now, if the block was thinking). A thinking line carries
// `thinkingDurationMs`, so its start is its own timestamp less that.
//
// Usage:
//   node scripts/perf-bench/claude-thinking-lead.mjs [--root <projects folder>] [--sessions <claude-threads.json>] [--since 2026-09-01] [--files 400]
//
// `--sessions` keeps the sessions a Sotto data folder's `claude-threads.json` names; only their session IDs are read
// from it. Claude Code records a thinking block's duration from 2.1.288, so only replies from that version on count.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const flag = (name, fallback) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : fallback }
const root = flag('--root', join(homedir(), '.claude', 'projects'))
const sessionsFile = flag('--sessions', undefined)
const sessions = sessionsFile ? new Set(Object.values(JSON.parse(readFileSync(sessionsFile, 'utf8'))).map(alias => alias?.sessionId).filter(Boolean)) : undefined
const recorded = version => { const [major, minor, patch] = String(version).split('.').map(Number); return major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 288))) }
const since = Date.parse(flag('--since', '1970-01-01'))
const limit = Number(flag('--files', '400'))

const files = readdirSync(root).flatMap(folder => {
  try { return readdirSync(join(root, folder)).filter(name => name.endsWith('.jsonl')).map(name => join(root, folder, name)) } catch { return [] }
}).map(path => ({ path, modified: statSync(path).mtimeMs })).filter(file => file.modified >= since)
  .sort((a, b) => b.modified - a.modified).slice(0, limit)

const authored = line => line.type === 'user' && !line.isSidechain && !line.isMeta && (typeof line.message?.content === 'string'
  || (Array.isArray(line.message?.content) && line.message.content.some(block => block?.type === 'text') && !line.message.content.some(block => block?.type === 'tool_result')))
const before = [], after = [], lead = [], thoughtBefore = [], thoughtAfter = []
let turns = 0, openedOnThinking = 0, withWords = 0, thinkingFirst = 0, blocks = 0, blocksWithWords = 0
for (const { path } of files) {
  let prompt
  for (const text of readFileSync(path, 'utf8').split('\n')) {
    if (!text) continue
    let line; try { line = JSON.parse(text) } catch { continue }
    if (sessions && !sessions.has(line.sessionId)) continue
    const at = Date.parse(line.timestamp)
    if (!Number.isFinite(at) || at < since) continue
    if (authored(line)) { prompt = at; continue }
    if (line.type === 'assistant' && !line.isSidechain && recorded(line.version) && line.message?.content?.[0]?.type === 'thinking') {
      blocks++
      if (line.message.content[0].thinking) blocksWithWords++
    }
    if (prompt === undefined || line.type !== 'assistant' || line.isSidechain || !Array.isArray(line.message?.content)) continue
    if (!recorded(line.version)) { prompt = undefined; continue }
    turns++
    const waited = at - prompt
    before.push(waited)
    const block = line.message.content[0]
    if (block?.type === 'thinking' || block?.type === 'redacted_thinking') thinkingFirst++
    if ((block?.type === 'thinking' || block?.type === 'redacted_thinking') && typeof line.thinkingDurationMs === 'number') {
      openedOnThinking++
      if (block.thinking) withWords++
      const shown = Math.max(0, waited - line.thinkingDurationMs)
      after.push(shown); lead.push(waited - shown); thoughtBefore.push(waited); thoughtAfter.push(shown)
    } else after.push(waited)
    prompt = undefined
  }
}
const quantile = (values, q) => { if (!values.length) return NaN; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] }
const seconds = value => `${(value / 1000).toFixed(1)} s`
const row = (name, values) => console.log(`${name.padEnd(44)} median ${seconds(quantile(values, 0.5))}, p90 ${seconds(quantile(values, 0.9))}`)
console.log(`${files.length} transcripts, ${turns} prompts answered, ${thinkingFirst} opened on a thinking block, ${openedOnThinking} of them with a recorded duration (${withWords} of those with words)`)
row('Prompt to first block finished (before)', before)
row('Prompt to first block started (after)', after)
row('  of those opening on thinking, before', thoughtBefore)
row('  of those opening on thinking, after', thoughtAfter)
row('Lead the thinking row gives, where it opened', lead)
console.log(`Thinking blocks on the main chain: ${blocks}, ${blocksWithWords} with words in the transcript`)
