import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { GrokAcpHost } from '../../src/main/agents/grok'
import type { RecordedRpc } from './codexFixture'
import type { AdapterSessionOptions } from '../integration/adapterContract'
/** The frames the fake client's one-shot mode was sent, grouped into Sotto's side calls (ADR-0026). */
async function sideCalls(root: string): Promise<{ cwd: string; model: string | undefined; material: string }[]> {
 const frames = (await readFile(join(root,'oneshot.jsonl'),'utf8').catch(()=>'')).trim().split('\n').filter(Boolean).map(line => (JSON.parse(line) as { frame: { method?: string; params?: Record<string, unknown> } }).frame)
 const opened = frames.filter(frame => frame.method === 'session/new')
 return opened.map((open, index) => ({ cwd: String(open.params?.cwd),
  model: frames.filter(frame => frame.method === 'session/set_model')[index]?.params?.modelId as string | undefined,
  material: ((frames.filter(frame => frame.method === 'session/prompt')[index]?.params?.prompt as { text: string }[] | undefined) ?? []).map(part => part.text).join('') }))
}
// The deadline also covers the fake agent's process start; see the note on claudeFixture.
export async function grokFixture(root?: string, requestTimeoutMs = 2000, pollIntervalMs = 20, session: AdapterSessionOptions = {}) {
 root ??= await mkdtemp(join(tmpdir(),'sotto-grok-thread-'))
 const adapter = new GrokAcpHost(root,{executable:process.execPath,args:[resolve('tests/fixtures/fakeGrokThreadAgent.mjs'),root],requestTimeoutMs,pollIntervalMs,...session})
 const checkViolations = async () => { const text = await readFile(join(root,'violations.jsonl'),'utf8').catch(()=>''); if (text) throw new Error(`Invalid Grok reply: ${text}`) }
 const requests = async (): Promise<RecordedRpc[]> => { await checkViolations(); return (await readFile(join(root,'requests.jsonl'),'utf8').catch(()=>'')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)) }
 const script = (value: unknown) => writeFile(join(root,'script.json'),JSON.stringify(value))
 const realId = async (id: string): Promise<string> => JSON.parse(await readFile(join(root,'grok-threads.json'),'utf8'))[id].grokSessionId
 const action = async (id: string, value: Record<string,unknown>) => { await writeFile(join(root,'control.json'),JSON.stringify({id:randomUUID(),sessionId:await realId(id),...value})) }
 return {host:adapter,adapter,root,projectId:'project',modelId:'fixture-model',realId,script,action,
  // A permission change comes back with the snapshot Grok's reload confirmed (#318).
  settings:{snapshot:true},
  sideWriting:{answer:(text:string)=>writeFile(join(root,'oneshot.json'),JSON.stringify({text})),calls:()=>sideCalls(root)},
  protocol:{promptMethod:'session/prompt',resumeMethod:'session/load',permissionDecision:(record:RecordedRpc): boolean|undefined=>{
   const outcome = record.result?.outcome as {outcome?:string;optionId?:string}|undefined
   return outcome?.outcome === 'cancelled' ? false : outcome?.outcome === 'selected' ? outcome.optionId === 'yes' : undefined
  }},
  sessions:{
   // A Grok session starts with session/load and stops with the close the agent answers.
   starts:async(id:string)=>{const native=await realId(id);return (await requests()).filter(record=>record.method==='session/load'&&record.params?.sessionId===native).length},
   stopped:async(id:string)=>{const native=await realId(id);return (await requests()).some(record=>record.method==='_x.ai/session/close'&&record.params?.sessionId===native)},
  },
  driver:{typeInProvider:(id:string,text:string)=>action(id,{type:'takeover',text}),completeTurn:(id:string,text:string)=>action(id,{type:'complete',text}),raiseQuestion:(id:string,text:string)=>action(id,{type:'question',text}),raisePermission:(id:string,text:string)=>action(id,{type:'permission',text}),delayNextAck:async()=>script({delayPrompt:requestTimeoutMs+1000,suppressNotifications:true}),requests,
   restart:async()=>{adapter.disconnect();await adapter.closed();return grokFixture(root,requestTimeoutMs,pollIntervalMs,session)}},
  cleanup:async()=>{adapter.disconnect();await adapter.closed();if(dirname(resolve(root))!==resolve(tmpdir())||!root.includes('sotto-grok-thread-'))throw new Error('Unexpected temporary directory');try{await checkViolations()}finally{await rm(root,{recursive:true,force:true})}}
 }
}
