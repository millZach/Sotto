import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { clearInterval } from 'node:timers'
import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const root = process.argv[2]
const path = name => join(root, name)
const read = (name, fallback) => { try { return JSON.parse(readFileSync(path(name), 'utf8')) } catch { return fallback } }
if (process.argv.includes('inspect')) { process.stdout.write(JSON.stringify(read('skills.json', { skills: [] }))); process.exit(0) }
// Sotto's side writing (ADR-0026): its own tool-free `agent --no-leader stdio` process on a throwaway home,
// never a thread's process. It records each frame it was sent in oneshot.jsonl as it arrives (the client
// kills it on close), never in requests.jsonl or the native sessions, and answers from oneshot.json.
if (process.argv.includes('--deny')) {
 const script = read('oneshot.json', {})
 const reply = frame => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n')
 const call = { args: process.argv.slice(3), cwd: process.cwd(), home: process.env.GROK_HOME }
 const catalog = { currentModelId: 'fixture-model', availableModels: [{ modelId: 'fixture-model', name: 'Fixture Grok', _meta: { supportsReasoningEffort: true, reasoningEffort: 'high', reasoningEfforts: [{ id: 'high' }, { id: 'low' }] } }] }
 createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line); appendFileSync(path('oneshot.jsonl'), JSON.stringify({ ...call, frame }) + '\n')
  const p = frame.params ?? {}
  if (frame.method === 'initialize') reply({ id: frame.id, result: { protocolVersion: 1, authMethods: [{ id: 'cached_token' }] } })
  else if (frame.method === 'authenticate') reply({ id: frame.id, result: {} })
  else if (frame.method === 'session/new') {
   const profile = p._meta?.agentProfile
   if (!profile || profile.injectDefaultTools !== false || profile.tools?.length !== 0 || p.mcpServers?.length !== 0) appendFileSync(path('violations.jsonl'), JSON.stringify({ reason: 'Side writing must open a tool-free session' }) + '\n')
   reply({ id: frame.id, result: { sessionId: 'side-writing-session', models: catalog } })
  } else if (frame.method === 'session/set_model') {
   reply({ id: frame.id, result: { _meta: { model: { Ok: p.modelId } } } })
   reply({ method: '_x.ai/session_notification', params: { sessionId: p.sessionId, update: { sessionUpdate: 'model_changed', model_id: p.modelId, reasoning_effort: p._meta?.reasoningEffort } } })
  } else if (frame.method === 'session/prompt') {
   if (script.fail) { reply({ id: frame.id, error: { code: -32603, message: 'Scripted failure' } }); return }
   reply({ method: 'session/update', params: { sessionId: p.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: script.text ?? 'Fixture title' } } } })
   reply({ id: frame.id, result: { stopReason: 'end_turn' } })
  } else if (frame.id !== undefined) reply({ id: frame.id, error: { code: -32601, message: 'Not in this fixture' } })
 }).on('close', () => process.exit(0))
 // The thread agent below never starts in this process: module evaluation waits here until the call ends.
 await new Promise(() => {})
}
// Sotto runs one of these per thread session, as Grok's own `agent --no-leader stdio` (T3 Code's shape), so
// several share this root at once. The durable store stays one native-sessions.json that tests read and
// seed, and each process writes back only the sessions it holds, under a lock, so none overwrites another's.
// A session is held by the process that created or loaded it; one nobody holds is read from disk.
const sessions = {}
const resident = new Set()
const pause = new Int32Array(new SharedArrayBuffer(4))
/** Whether a process is still running. One that cannot be signalled but exists counts as running. */
const running = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }
/**
 * The lock file names its holder. A holder killed mid-write leaves it behind, and it is taken over only once that
 * process is gone, never after a length of time: a holder a busy machine has paused is still holding it.
 */
function locked(work) {
 const lock = path('native-sessions.lock')
 for (;;) {
  try { const fd = openSync(lock, 'wx'); try { writeSync(fd, String(process.pid)) } finally { closeSync(fd) } break } catch (error) {
   if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error
   try {
    const before = statSync(lock, { bigint: true }).ino
    const holder = Number(readFileSync(lock, 'utf8'))
    // An empty file is a holder between creating it and writing its name; the same file is checked before removing.
    if (holder && !running(holder) && statSync(lock, { bigint: true }).ino === before) rmSync(lock, { force: true })
   } catch { /* Released meanwhile. */ }
   Atomics.wait(pause, 0, 0, 2)
  }
 }
 try { return work() } finally { rmSync(lock, { force: true }) }
}
// Which process holds each resident session, so a command for a session goes to its holder and no other.
const holders = () => path('holders')
function holding(sessionId, held) {
 mkdirSync(holders(), { recursive: true })
 const file = join(holders(), sessionId)
 if (held) { writeFileSync(file, String(process.pid)); return }
 try { if (Number(readFileSync(file, 'utf8')) === process.pid) rmSync(file, { force: true }) } catch { /* Not held here. */ }
}
/** The running process holding a session resident, if any. */
function holderOf(sessionId) {
 try { const pid = Number(readFileSync(join(holders(), sessionId), 'utf8')); return pid && running(pid) ? pid : undefined } catch { return undefined }
}
const stored = () => read('native-sessions.json', {})
// Another process may be halfway through writing the store, so a read takes the lock as a write does.
const current = () => locked(stored)
const save = () => { if (Object.keys(sessions).length) locked(() => { const all = stored(); Object.assign(all, sessions); writeFileSync(path('native-sessions.json'), JSON.stringify(all)) }) }
// A session taken from disk carries no prompt: the process that owned its prompt is gone, and its reply
// is never rerouted to another process.
function hold(sessionId) {
 if (!sessions[sessionId]) { const session = current()[sessionId]; if (!session) return undefined; delete session.promptId; sessions[sessionId] = session }
 return sessions[sessionId]
}
/** Put back a session this process does not hold resident, so a later load reads it fresh from disk. */
function letGo(sessionId) { if (!resident.has(sessionId) && sessions[sessionId]) { save(); delete sessions[sessionId] } }
const send = frame => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n')
// Every record names the process that received it, so a test can tell one thread's process from another's.
const record = frame => appendFileSync(path('requests.jsonl'), JSON.stringify({ ...frame, process: process.pid }) + '\n')
// A process is one binary: the version it reports is the one it started as, whatever script.json says later.
const startup = read('script.json', {})
record({ method: 'fixture/process', params: { pid: process.pid, version: startup.cliVersion ?? '1.0.5' } })
const defaultCatalog = { currentModelId: 'fixture-model', availableModels: [{ modelId: 'fixture-model', name: 'Fixture Grok', _meta: { supportsReasoningEffort: true, reasoningEffort: 'high', reasoningEfforts: [{ id: 'high' }] } }] }
// script.json may carry a whole catalog, so a case can reproduce Grok's own highest-first level list.
const catalogOf = script => script.catalog ?? defaultCatalog
const pending = new Map(); let serial = 5000
/** A `session/new` answer held back by `holdCreate`. */
let heldCreate
// Mirrors Grok 1.0.5 as probed through SessionStart hooks: _meta applies when a session starts or is
// loaded while not resident; loading a resident session can add always-approve but never removes it.
const nativeMode = meta => meta?.yoloMode ? 'bypassPermissions' : meta?.autoMode ? 'auto' : 'default'
// Sotto must always state both flags explicitly, never both on, and never swap the agent profile.
function checkPolicy(meta) {
 if (typeof meta?.yoloMode !== 'boolean' || typeof meta?.autoMode !== 'boolean' || (meta.yoloMode && meta.autoMode) || meta.agentProfile) appendFileSync(path('violations.jsonl'),JSON.stringify({reason:'Coding session policy wrong',meta})+'\n')
}
function update(sessionId, update, extension = false, notify = true, meta = {}) {
 const entry = { timestamp: Math.floor(Date.now()/1000), method: extension ? '_x.ai/session/update' : 'session/update', params: { sessionId, update, _meta: {eventId:read('script.json',{}).reusedEventIds ? `${sessionId}-2` : randomUUID(),agentTimestampMs:Date.now(),...meta} } }
 hold(sessionId).updates.push(entry); save()
 if (notify) send(entry)
}
// With `thought`, the reply opens on thought chunks, as Grok 1.0.46 sends them: the thought and the reply that
// follows share one prompt and one stream start in `_meta`, which is how its history keeps them too.
function complete(sessionId, text, reason = 'end_turn', thought) {
 const stream = typeof thought === 'string' ? { promptId: `prompt-${sessionId}`, streamStartMs: Date.now() } : {}
 if (typeof thought === 'string') {
  const middle = Math.ceil(thought.length / 2)
  for (const part of thought ? [thought.slice(0, middle), thought.slice(middle)] : ['']) update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: {type:'text',text:part} }, false, true, stream)
 }
 if (text) update(sessionId, { sessionUpdate: 'agent_message_chunk', content: {type:'text',text} }, false, true, stream)
 update(sessionId, {sessionUpdate:'turn_completed',prompt_id:sessionId,stop_reason:reason},true)
 const id = sessions[sessionId].promptId; if (id) send({id,result:{stopReason:reason}})
 delete sessions[sessionId].promptId; save()
}
function validate(frame, request) {
 const result = frame.result
 // A request Sotto cannot read is refused at the protocol level, which is the whole point of the case.
 if (request.kind === 'unreadable') return frame.error ? undefined : 'Expected a refusal for an unreadable request'
 if (request.kind === 'permission') {
  if (!result || Object.keys(result).join() !== 'outcome' || !result.outcome || !['selected','cancelled'].includes(result.outcome.outcome)) return 'Expected ACP permission outcome'
  if (result.outcome.outcome === 'selected' && (Object.keys(result.outcome).sort().join() !== 'optionId,outcome' || !['yes','no'].includes(result.outcome.optionId))) return 'Unknown permission optionId'
  if (result.outcome.outcome === 'cancelled' && Object.keys(result.outcome).join() !== 'outcome') return 'Cancelled permission carries an option'
 } else {
  if (!result || !['accepted','cancelled'].includes(result.outcome)) return 'Expected native question outcome'
  if (result.outcome === 'accepted') {
   if (!result.answers || !Array.isArray(result.answers[request.text]) || result.answers[request.text].some(answer => typeof answer !== 'string')) return 'Expected answers keyed by question text'
   if (result.answers[request.text].includes('Other') && typeof result.annotations?.[request.text]?.notes !== 'string') return 'Freeform answer needs annotation notes'
  }
 }
 return undefined
}
createInterface({input:process.stdin}).on('line', line => {
 // A process can start, answer and end between two ticks, so it looks for a command before each frame.
 check()
 const frame = JSON.parse(line); record(frame)
 if (!frame.method) {
  const request = pending.get(frame.id)
  if (!request) { appendFileSync(path('violations.jsonl'), JSON.stringify({reason:'Unknown/duplicate response ID'})+'\n'); return }
  const reason = validate(frame,request)
  if (reason) appendFileSync(path('violations.jsonl'),JSON.stringify({reason})+'\n')
  pending.delete(frame.id); return
 }
 const p = frame.params ?? {}; const script = read('script.json', {})
 if (frame.method === 'initialize') send({id:frame.id,result:{protocolVersion:script.protocolVersion ?? 1,agentCapabilities:{loadSession:true,mcpCapabilities:{http:script.browserHttp ?? true},promptCapabilities:{image:false,audio:false,embeddedContext:true}},authMethods:script.authMethods ?? [{id:'cached_token'}],_meta:{agentVersion:startup.cliVersion ?? '1.0.5',modelState:catalogOf(script)}}})
 else if (frame.method === 'authenticate') { if (!script.ignoreAuthenticate) send({id:frame.id,result:{}}) }
 else if (frame.method === 'session/new') {
  checkPolicy(p._meta)
  const sessionId = randomUUID(); sessions[sessionId] = {cwd:p.cwd,updates:[],permissionMode:nativeMode(p._meta)}; resident.add(sessionId); holding(sessionId, true); save()
  record({method:'fixture/session-resident',params:{sessionId,resident:true}})
  const reply = () => send({id:frame.id,result:{sessionId,models:catalogOf(script)}})
  // `holdCreate` keeps the answer until a `release-create` command, so a test can act while a create is open.
  if (script.holdCreate) heldCreate = reply
  else if (script.delayCreate) setTimeout(reply,script.delayCreate); else reply()
 }
 else if (frame.method === 'session/load') {
  checkPolicy(p._meta)
  if (!hold(p.sessionId)) send({id:frame.id,error:{code:-32602,message:'Missing session'}})
  else if (script.rejectLoad) { letGo(p.sessionId); send({id:frame.id,error:{code:-32603,message:'Rejected load'}}) }
  else {
   const session = sessions[p.sessionId]
   if (!resident.has(p.sessionId)) session.permissionMode = nativeMode(p._meta)
   else if (p._meta?.yoloMode) session.permissionMode = 'bypassPermissions'
   resident.add(p.sessionId); holding(p.sessionId, true); save()
   record({method:'fixture/session-resident',params:{sessionId:p.sessionId,resident:true}})
   send({id:frame.id,result:{models:catalogOf(script),_meta:{sessionId:p.sessionId}}})
  }
 }
 else if (frame.method === '_x.ai/session/close') {
  if (script.rejectClose) { send({id:frame.id,error:{code:-32603,message:'Rejected close'}}); return }
  const closed = resident.delete(p.sessionId); holding(p.sessionId, false)
  letGo(p.sessionId)
  record({method:'fixture/session-resident',params:{sessionId:p.sessionId,resident:false}})
  send({id:frame.id,result:{result:{success:true,outcome:closed ? 'closed' : 'notResident'}}})
 }
 else if (frame.method === 'session/set_model') {
  if (script.rejectModel) send({id:frame.id,error:{code:-32602,message:'Rejected model'}})
  else {
   if (!script.modelNotificationAfterResponse) send({method:'_x.ai/session_notification',params:{sessionId:p.sessionId,update:{sessionUpdate:'model_changed',model_id:p.modelId,reasoning_effort:p._meta?.reasoningEffort ?? 'high'}}})
   send({id:frame.id,result:{_meta:{model:{Ok:p.modelId}}}})
  }
 }
 else if (frame.method === '_x.ai/session/updates') {
  if (script.ignoreHistory) return
  // Durable history is readable whether or not this process holds the session.
  const updates = ((sessions[p.sessionId] ?? current()[p.sessionId])?.updates ?? []).slice(0,script.historyVisibleCount); const page = updates.slice(p.offset,p.offset+p.limit)
  // A real page carries whatever the session's tools printed. The padding is a field the adapter's
  // schema drops, so the line is page-sized without the test keeping a page-sized message.
  const padding = script.historyPadBytes ? {padding:'x'.repeat(script.historyPadBytes)} : {}
  send({id:frame.id,result:{updates:page,totalCount:updates.length,hasMore:p.offset+page.length<updates.length,...padding}})
 }
 else if (frame.method === 'session/prompt') {
  if (!resident.has(p.sessionId)) appendFileSync(path('violations.jsonl'), JSON.stringify({reason:'Prompt for a session this process has not loaded'})+'\n')
  if (script.writeCwd) writeFileSync(join(sessions[p.sessionId].cwd, 'native-cwd-proof.txt'), p.prompt[0].text)
  if (script.rejectPrompt) { send({id:frame.id,error:{code:-32602,message:'Rejected'}}); return }
  sessions[p.sessionId].promptId = frame.id; save()
  const apply = () => update(p.sessionId,{sessionUpdate:'user_message_chunk',content:p.prompt[0]},false,!script.suppressNotifications)
  if (script.delayPrompt) setTimeout(apply,script.delayPrompt); else apply()
 }
 else if (frame.method === 'session/cancel') complete(p.sessionId,'','cancelled')
 else send({id:frame.id,error:{code:-32601,message:'Unknown method'}})
}).on('close', () => {
 // No leader keeps a session once its process ends: what this process held is no longer resident anywhere.
 save(); clearInterval(control)
 for (const sessionId of resident) { holding(sessionId, false); record({method:'fixture/session-resident',params:{sessionId,resident:false}}) }
 process.exit(0)
})
// Several processes read control.json. A command for a session another running process holds is that process's
// alone; one for a session nobody holds, or with no session, goes to whichever process claims it first. A command
// is carried out once: its claim is a file only one process can create.
let last
function claim(command) {
 if (command.type === 'release-create' && !heldCreate) return false
 if (command.sessionId && !resident.has(command.sessionId)) { const holder = holderOf(command.sessionId); if (holder && holder !== process.pid) return false }
 try { mkdirSync(path('control-claims'), {recursive:true}); writeFileSync(path(`control-claims/${command.id}`), String(process.pid), {flag:'wx'}); return true }
 catch { return 'taken' }
}
function check() {
 if (!existsSync(path('control.json'))) return
 const command = read('control.json', {}); if (!command.id || command.id === last) return
 const claimed = claim(command); if (!claimed) return
 last = command.id; if (claimed === 'taken') return
 if (command.sessionId && !hold(command.sessionId)) return
 try { run(command) } finally { if (command.sessionId) letGo(command.sessionId) }
}
const control = setInterval(check, 10)
function run(command) {
 if (command.type === 'release-create') { const reply = heldCreate; heldCreate = undefined; reply?.() }
 if (command.type === 'complete') complete(command.sessionId,command.text,command.reason,command.thought)
 if (command.type === 'thought') update(command.sessionId,{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:command.text}},false,true,command.meta)
 if (command.type === 'takeover') update(command.sessionId,{sessionUpdate:'user_message_chunk',content:{type:'text',text:command.text}},false,command.notify ?? false)
 if (command.type === 'chunk') update(command.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:command.text}},false,true,command.meta)
 if (command.type === 'raw-burst') process.stdout.write(command.frames.map(frame => JSON.stringify({jsonrpc:'2.0',...frame})+'\n').join(''))
 if (command.type === 'coalesce') {
  const entries = sessions[command.sessionId].updates.filter(entry => entry.params.update.sessionUpdate === (command.update ?? 'agent_message_chunk') && entry.params._meta.streamStartMs === command.streamStartMs)
  const text = entries.map(entry => entry.params.update.content.text).join('')
  const last = entries.at(-1)
  if (last) { sessions[command.sessionId].updates = sessions[command.sessionId].updates.filter(entry => !entries.includes(entry) || entry === last); last.params.update.content.text = text; save() }
 }
 if (command.type === 'activity') update(command.sessionId,command.update,command.extension ?? false,command.notify ?? true)
 if (command.type === 'replay') { const entry = sessions[command.sessionId].updates.at(-1); if (entry) send(entry) }
 if (command.type === 'malformed') process.stdout.write('{bad json}\n')
 if (command.type === 'inherited-exit') {spawn(process.execPath,['-e','setTimeout(()=>{},1000)'],{stdio:['ignore',process.stdout,process.stderr],windowsHide:true});process.exit(0)}
 if (command.type === 'permission' || command.type === 'question') {
  const id = ++serial; pending.set(id,{kind:command.type,text:command.text})
  if (command.type === 'permission') send({id,method:'session/request_permission',params:{sessionId:command.sessionId,toolCall:{toolCallId:String(id),title:command.text,...(command.rawInput===undefined?{}:{rawInput:command.rawInput})},options:[{optionId:'yes',name:'Allow once',kind:'allow_once'},{optionId:'no',name:'Deny',kind:'reject_once'}]}})
  // 1.0.40 puts a question's own parameters straight under the underscored method; earlier clients
  // wrapped them in an envelope naming the method again. Both are the same request.
  else {
   const ask = {sessionId:command.sessionId,toolCallId:String(id),questions:[{question:command.text,options:[]}],mode:'default'}
   send({id,method:'_x.ai/ask_user_question',params:command.unwrapped ? ask : {method:'x.ai/ask_user_question',params:ask}})
  }
 }
 // A future client asking for a person under a name this Sotto has never mapped.
 if (command.type === 'unreadable') {
  const id = ++serial; pending.set(id,{kind:'unreadable'})
  send({id,method:command.method,params:{sessionId:command.sessionId,toolCallId:String(id),questions:[{question:command.text,options:[]}],...command.params}})
 }
}
