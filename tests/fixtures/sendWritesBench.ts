/** Child-process workload for sendWrites.perf.test.ts; synthetic threads, prompts and replies only. */
import { recordDurableWrites } from './durableWrites'
import { DEVELOPMENT_STORE_BYTES, measureSendWrites } from './sendWritesWorkload'

const [provider, sendsText] = process.argv.slice(2)
if (provider !== 'claude' && provider !== 'codex') throw new Error('Expected claude or codex')
const recorder = recordDurableWrites()
const sends = await measureSendWrites(provider, recorder, Number(sendsText ?? 6), DEVELOPMENT_STORE_BYTES[provider])
console.log(JSON.stringify(sends))
// The fake clients' processes have been stopped; anything left would only hold the bench open.
process.exit(0)
