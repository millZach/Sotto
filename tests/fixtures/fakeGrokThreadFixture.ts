import { parseProviderRecords, writeProviderAction } from './providerRecords'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { GrokAcpHost, type GrokAcpOptions } from '../../src/main/agents/grok'
import type { GrokRpc } from '../../src/main/agents/grokRpc'
import type { AdapterContractSkips, AdapterSessionOptions, RecordedRpc } from './adapterFixture'

export const grokFixtureSkips: AdapterContractSkips = {
 backgroundWork: 'The fixture has no background-work driver.',
 liveSettings: 'The fixture must apply settings to a live provider session.',
 settingsConfirmation: 'The fixture cannot lose a settings-change confirmation.',
}
/** A log may not exist before its first event; any other read failure is evidence, not an empty trace. */
async function readLog(path: string): Promise<string> {
 try { return await readFile(path, 'utf8') }
 catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error }
}
/** The frames the fake client's one-shot mode was sent, grouped into Sotto's side calls (ADR-0026). */
async function sideCalls(root: string): Promise<{ cwd: string; model: string | undefined; material: string }[]> {
 const frames = parseProviderRecords<{ frame: { method?: string; params?: Record<string, unknown> } }>(await readFile(join(root,'oneshot.jsonl'),'utf8').catch(() => '')).map(record => record.frame)
 const opened = frames.filter(frame => frame.method === 'session/new')
 return opened.map((open, index) => ({ cwd: String(open.params?.cwd),
  model: frames.filter(frame => frame.method === 'session/set_model')[index]?.params?.modelId as string | undefined,
  material: ((frames.filter(frame => frame.method === 'session/prompt')[index]?.params?.prompt as { text: string }[] | undefined) ?? []).map(part => part.text).join('') }))
}
/**
 * How long an operation waits once a test has scripted its reply lost. Sotto finds a Grok reply lost only when its
 * deadline passes, so the test of that waits one out. A short one is safe there: a slow runner can only delay a reply
 * the fake is already holding back.
 */
export const LOST_REPLY_DEADLINE_MS = 2000
/** What `delayNextAck` scripts for each request whose reply it can lose. Every reply it delays misses the short deadline by a second. */
const lostReplies: Record<string, Record<string, unknown>> = {
 'session/prompt': { delayPrompt: LOST_REPLY_DEADLINE_MS + 1000, suppressNotifications: true },
 'session/new': { delayCreate: LOST_REPLY_DEADLINE_MS + 1000 },
 authenticate: { ignoreAuthenticate: true },
 '_x.ai/session/updates': { ignoreHistory: true },
}
// The request deadline covers the fake agent's process start and every round trip on it. Grok starts a process for each
// thread, and on a loaded run `session/new` there took longer than two seconds, so the create came back uncertain and
// the next send found no confirmed provider session (#1021). The default is the adapter's own; a test that needs a reply
// lost scripts it with `driver.delayNextAck` instead of shortening this.
// A sweep leaves a session open while its history is being read (#440), and only a later sweep stops it. A poll on the
// sweep's own period fires on the same timer tick (Windows rounds a 20 ms timer to two 15.6 ms ticks), so when the two
// start in step every sweep finds a read under way and an idle session is never stopped. A poll several sweeps long
// leaves most sweeps between reads. A caller that names its own interval keeps it.
export async function grokFixture(root?: string, requestTimeoutMs = 15_000, pollIntervalMs?: number, session: AdapterSessionOptions = {}, options: GrokAcpOptions = {}) {
 pollIntervalMs ??= session.reaperSweepMs === undefined ? 20 : session.reaperSweepMs * 5
 root ??= await mkdtemp(join(tmpdir(),'sotto-grok-thread-'))
 // Only a request scripted lost waits the short deadline; every other one, on every process, keeps the generous one.
 // A send reads its acknowledgement deadline from these options as it writes its prompt, and a process reads its own
 // when it starts, so the short one goes to the one send whose prompt was scripted lost and to each request of a method
 // whose reply was.
 let promptLost = false, spawning = false
 const lostRequests = new Set<string>()
 // Requests of each method sent with the generous deadline that have no reply yet. A reply scripted lost is lost only once
 // these have theirs: one already on its way when the script changed would otherwise be lost too, and wait out the
 // generous deadline (a history poll in flight held a send's own read behind it for 15 seconds).
 const unanswered = new Map<string, Set<Promise<void>>>()
 const adapterOptions: GrokAcpOptions = {executable:process.execPath,args:[resolve('tests/fixtures/fakeGrokThreadAgent.mjs'),root],pollIntervalMs,...session,...options}
 Object.defineProperty(adapterOptions,'requestTimeoutMs',{enumerable:true,get:()=>{
  if (spawning || !promptLost) return requestTimeoutMs
  promptLost = false; return LOST_REPLY_DEADLINE_MS
 }})
 const adapter = new GrokAcpHost(root,adapterOptions)
 const spawner = adapter as unknown as { spawn(...args: unknown[]): GrokRpc }
 const spawn = spawner.spawn.bind(adapter)
 spawner.spawn = (...args) => {
  spawning = true
  let rpc: GrokRpc
  try { rpc = spawn(...args) } finally { spawning = false }
  const deadline = rpc as unknown as { timeoutMs: number }, request = rpc.request.bind(rpc)
  rpc.request = (method, ...rest) => {
   if (!lostRequests.has(method)) {
    const sent = request(method, ...rest)
    const waiting = unanswered.get(method) ?? new Set<Promise<void>>(); unanswered.set(method, waiting)
    waiting.add(sent); const answered = () => { waiting.delete(sent) }; sent.then(answered, answered)
    return sent
   }
   deadline.timeoutMs = LOST_REPLY_DEADLINE_MS
   try { return request(method, ...rest) } finally { deadline.timeoutMs = requestTimeoutMs }
  }
  return rpc
 }
 const checkViolations = async () => { const text = await readLog(join(root,'violations.jsonl')); if (text) throw new Error(`Invalid Grok reply: ${text}`) }
 const writeScript = (value: unknown) => writeFile(join(root,'script.json'),JSON.stringify(value))
 // A lost prompt is lost for the next send; any other method's replies stay lost until the script changes.
 const delayNextAck = async (method: string): Promise<void> => {
  const lost = lostReplies[method]
  if (!lost) throw new Error(`The Grok fixture cannot lose the reply to ${method}`)
  if (method === 'session/prompt') { await writeScript(lost); promptLost = true; return }
  // Every request from here on waits the short deadline, and the fake starts losing replies once every request sent
  // before has its reply, so no request that waits the generous deadline is lost.
  lostRequests.add(method)
  await Promise.allSettled([...unanswered.get(method) ?? []])
  await writeScript(lost)
 }
 const requests = async (): Promise<RecordedRpc[]> => {
  await checkViolations()
  const text = await readLog(join(root,'requests.jsonl'))
  return parseProviderRecords<RecordedRpc>(text)
 }
 const script = (value: unknown) => { promptLost = false; lostRequests.clear(); return writeScript(value) }
 const realId = async (id: string): Promise<string> => JSON.parse(await readFile(join(root,'grok-threads.json'),'utf8'))[id].grokSessionId
 // Each thread session has its own fake process (one ACP process per session). The one holding the session
 // takes the command; `at` lets another take it once nobody has. The wall clock, because tests mock Date.now.
 const action = async (id: string, value: Record<string,unknown>) => { const actionId = randomUUID(); await writeProviderAction(join(root, 'control.json'), value, { sessionId: await realId(id) }, actionId) }
 // Each thread session is its own Grok process, not a proxy to a shared leader, so a turn ends when Sotto
 // closes its process; the adapter says it was interrupted rather than leave it running forever.
 return {host:adapter,adapter,root,providerId:'grok' as const,projectId:'project',modelId:'fixture-model',realId,script,action,restartStatus:'idle' as const,skips:grokFixtureSkips,
  // A permission change comes back with the snapshot Grok's reload confirmed (#318).
  settings:{snapshot:true},
  // Every Grok process started from now on reports the newer client.
  clientUpdate:{provider:'grok' as const,install:async()=>{await script({cliVersion:'1.0.41'});return '1.0.41'}},
  sideWriting:{answer:(text:string)=>writeFile(join(root,'oneshot.json'),JSON.stringify({text})),calls:()=>sideCalls(root)},
  protocol:{promptMethod:'session/prompt',resumeMethod:'session/load',permissionDecision:(record:RecordedRpc): boolean|undefined=>{
   const outcome = record.result?.outcome as {outcome?:string;optionId?:string}|undefined
   return outcome?.outcome === 'cancelled' ? false : outcome?.outcome === 'selected' ? outcome.optionId === 'yes' : undefined
  }},
  sessions:{
   // Observe the current residency after an accepted load/close, not any historical close request.
   starts:async(id:string)=>{const native=await realId(id);return (await requests()).filter(record=>record.method==='session/load'&&record.params?.sessionId===native).length},
   stopped:async(id:string)=>{const native=await realId(id);return (await requests()).findLast(record=>record.method==='fixture/session-resident'&&record.params?.sessionId===native)?.params?.resident===false},
  },
  driver:{typeInProvider:(id:string,text:string)=>action(id,{type:'takeover',text}),completeTurn:(id:string,text:string)=>action(id,{type:'complete',text}),raiseQuestion:(id:string,text:string)=>action(id,{type:'question',text}),raisePermission:(id:string,text:string)=>action(id,{type:'permission',text}),delayNextAck,requests,
   restart:async()=>{adapter.disconnect();await adapter.closed();return grokFixture(root,requestTimeoutMs,pollIntervalMs,session,options)}},
  cleanup:async()=>{adapter.disconnect();await adapter.closed();if(dirname(resolve(root))!==resolve(tmpdir())||!root.includes('sotto-grok-thread-'))throw new Error('Unexpected temporary directory');try{await checkViolations()}finally{await rm(root,{recursive:true,force:true})}}
 }
}
