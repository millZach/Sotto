import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { clearInterval } from 'node:timers'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const root = process.argv[2]
const path = name => join(root, name)
const read = (name, fallback) => { try { return JSON.parse(readFileSync(path(name), 'utf8')) } catch { return fallback } }
const sessions = read('native-sessions.json', {})
// Leader work survives proxy restart, but replies for the departed proxy are not rerouted.
for (const session of Object.values(sessions)) delete session.promptId
const save = () => writeFileSync(path('native-sessions.json'), JSON.stringify(sessions))
const send = frame => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n')
const record = frame => appendFileSync(path('requests.jsonl'), JSON.stringify(frame) + '\n')
const catalog = { currentModelId: 'fixture-model', availableModels: [{ modelId: 'fixture-model', name: 'Fixture Grok', _meta: { supportsReasoningEffort: true, reasoningEffort: 'high', reasoningEfforts: [{ id: 'high' }] } }] }
const pending = new Map(); let serial = 5000
function update(sessionId, update, extension = false, notify = true) {
 const entry = { timestamp: Math.floor(Date.now()/1000), method: extension ? '_x.ai/session/update' : 'session/update', params: { sessionId, update, _meta: {eventId:read('script.json',{}).reusedEventIds ? `${sessionId}-2` : randomUUID(),agentTimestampMs:Date.now()} } }
 sessions[sessionId].updates.push(entry); save()
 if (notify) send(entry)
}
function complete(sessionId, text, reason = 'end_turn') {
 if (text) update(sessionId, { sessionUpdate: 'agent_message_chunk', content: {type:'text',text} })
 update(sessionId, {sessionUpdate:'turn_completed',prompt_id:sessionId,stop_reason:reason},true)
 const id = sessions[sessionId].promptId; if (id) send({id,result:{stopReason:reason}})
 delete sessions[sessionId].promptId; save()
}
function validate(frame, request) {
 const result = frame.result
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
 const frame = JSON.parse(line); record(frame)
 if (!frame.method) {
  const request = pending.get(frame.id)
  if (!request) { appendFileSync(path('violations.jsonl'), JSON.stringify({reason:'Unknown/duplicate response ID'})+'\n'); return }
  const reason = validate(frame,request)
  if (reason) appendFileSync(path('violations.jsonl'),JSON.stringify({reason})+'\n')
  pending.delete(frame.id); return
 }
 const p = frame.params ?? {}; const script = read('script.json', {})
 if (frame.method === 'initialize') send({id:frame.id,result:{protocolVersion:script.protocolVersion ?? 1,agentCapabilities:{loadSession:true},authMethods:[{id:'cached_token'}],_meta:{agentVersion:script.cliVersion ?? '1.0.5',modelState:catalog}}})
 else if (frame.method === 'authenticate') send({id:frame.id,result:{}})
 else if (frame.method === 'session/new') {
  if (p._meta?.yoloMode !== false || p._meta?.autoMode !== false || p._meta?.agentProfile) appendFileSync(path('violations.jsonl'),JSON.stringify({reason:'Coding session policy wrong'})+'\n')
  const sessionId = randomUUID(); sessions[sessionId] = {cwd:p.cwd,updates:[]}; save()
  const reply = () => send({id:frame.id,result:{sessionId,models:catalog}})
  if (script.delayCreate) setTimeout(reply,script.delayCreate); else reply()
 }
 else if (frame.method === 'session/load') {
  if (!sessions[p.sessionId]) send({id:frame.id,error:{code:-32602,message:'Missing session'}})
  else send({id:frame.id,result:{models:catalog,_meta:{sessionId:p.sessionId}}})
 }
 else if (frame.method === 'session/set_model') {
  if (script.rejectModel) send({id:frame.id,error:{code:-32602,message:'Rejected model'}})
  else {
   send({method:'_x.ai/session_notification',params:{sessionId:p.sessionId,update:{sessionUpdate:'model_changed',model_id:p.modelId,reasoning_effort:p._meta?.reasoningEffort ?? 'high'}}})
   send({id:frame.id,result:{_meta:{model:{Ok:p.modelId}}}})
  }
 }
 else if (frame.method === '_x.ai/session/updates') {
  if (script.ignoreHistory) return
  const updates = (sessions[p.sessionId]?.updates ?? []).slice(0,script.historyVisibleCount); const page = updates.slice(p.offset,p.offset+p.limit)
  send({id:frame.id,result:{updates:page,totalCount:updates.length,hasMore:p.offset+page.length<updates.length}})
 }
 else if (frame.method === 'session/prompt') {
  if (script.rejectPrompt) { send({id:frame.id,error:{code:-32602,message:'Rejected'}}); return }
  sessions[p.sessionId].promptId = frame.id; save()
  const apply = () => update(p.sessionId,{sessionUpdate:'user_message_chunk',content:p.prompt[0]},false,!script.suppressNotifications)
  if (script.delayPrompt) setTimeout(apply,script.delayPrompt); else apply()
 }
 else if (frame.method === 'session/cancel') complete(p.sessionId,'','cancelled')
 else send({id:frame.id,error:{code:-32601,message:'Unknown method'}})
}).on('close', () => {save();clearInterval(control);process.exit(0)})
let last
const control = setInterval(() => {
 if (!existsSync(path('control.json'))) return
 const command = read('control.json', {}); if (!command.id || command.id === last) return; last = command.id
 if (command.type === 'complete') complete(command.sessionId,command.text,command.reason)
 if (command.type === 'takeover') update(command.sessionId,{sessionUpdate:'user_message_chunk',content:{type:'text',text:command.text}},false,command.notify ?? false)
 if (command.type === 'chunk') update(command.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:command.text}})
 if (command.type === 'malformed') process.stdout.write('{bad json}\n')
 if (command.type === 'inherited-exit') {spawn(process.execPath,['-e','setTimeout(()=>{},1000)'],{stdio:['ignore',process.stdout,process.stderr],windowsHide:true});process.exit(0)}
 if (command.type === 'permission' || command.type === 'question') {
  const id = ++serial; pending.set(id,{kind:command.type,text:command.text})
  if (command.type === 'permission') send({id,method:'session/request_permission',params:{sessionId:command.sessionId,toolCall:{toolCallId:String(id),title:command.text},options:[{optionId:'yes',name:'Allow once',kind:'allow_once'},{optionId:'no',name:'Deny',kind:'reject_once'}]}})
  else send({id,method:'_x.ai/ask_user_question',params:{method:'x.ai/ask_user_question',params:{sessionId:command.sessionId,toolCallId:String(id),questions:[{question:command.text,options:[]}],mode:'default'}}})
 }
},10)
