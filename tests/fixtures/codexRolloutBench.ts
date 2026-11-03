/** Child-process workload for codexRolloutRead.perf.test.ts: the rollout reader catching up on real rollouts, read-only. */
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { CodexSessionLogWatcher } from '../../src/main/agents/codexSessionLog'

const [codexHome, listPath] = process.argv.slice(2)
if (!codexHome || !listPath) throw new Error('Expected a Codex home and a file listing the thread IDs to read')
const threadIds = JSON.parse(await readFile(listPath, 'utf8')) as string[]
const seen: string[] = []
const watcher = new CodexSessionLogWatcher({ codexHome, onMessage: (threadId, message) => { seen.push(`${threadId}\t${message.id}\t${message.text}`) } })
for (const threadId of threadIds) watcher.observe(threadId)
const cpu = process.cpuUsage(), started = performance.now()
// As a first read of a thread with no saved position runs: every rollout read to its end.
for (const threadId of threadIds) await watcher.pollThread(threadId, true)
const used = process.cpuUsage(cpu), wall = performance.now() - started
// The identities each thread's reading kept: its turns' user and assistant rows, their native IDs and the turn it is in.
const tails = (watcher as unknown as { tails: Map<string, { identities: { snapshot(): unknown } }> }).tails
const identities = threadIds.map(threadId => `${threadId}\t${JSON.stringify(tails.get(threadId)?.identities.snapshot() ?? null)}`)
await watcher.stop()
console.log(JSON.stringify({ cpuMs: (used.user + used.system) / 1000, wallMs: wall, messages: seen.length,
  digest: createHash('sha256').update(seen.sort().join('\n')).update('\n\n').update(identities.join('\n')).digest('hex') }))
