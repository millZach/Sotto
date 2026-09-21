// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'
import { grokEnvironment } from '../../src/main/agents/grokRpc'
import { SottoThreadHost, ThreadRegistry } from '../../src/main/agents/threads'
let f: Awaited<ReturnType<typeof grokFixture>> | undefined
afterEach(async()=> {await f?.cleanup();f=undefined})
async function setup() {
 f = await grokFixture(); await f.host.connect()
 await f.host.execute({type:'create-project',commandId:randomUUID(),projectId:f.projectId,title:'Project',path:f.root})
 const id = randomUUID()
 await f.host.execute({type:'create-thread',commandId:randomUUID(),threadId:id,projectId:f.projectId,modelId:f.modelId,title:'Test'})
 return id
}
const send = (id:string,messageId='own',text='Synthetic prompt')=>f!.host.execute({type:'send',commandId:messageId,threadId:id,messageId,text})
it.each([
 {script:{cliVersion:'1.0.4'},says:'Grok CLI 1.0.5 or newer is required, and this client is 1.0.4.'},
 {script:{protocolVersion:2},says:'Sotto speaks ACP 1, and this client answered ACP 2.'},
])('refuses a client older than the verified version, or another protocol, before authentication, and names which (%j)',async({script,says})=>{
 f=await grokFixture();await f.script(script)
 const error=await f.host.connect().then(()=>undefined,(reason:Error)=>reason)
 expect(error?.message).toBe(`Could not connect Grok. ${says}`)
 // The refusal is the one case retrying cannot change, so it does not invite another press.
 expect(error?.message).not.toContain('Connect again to retry.')
 expect((await f.driver.requests()).some(request=>request.method==='authenticate')).toBe(false)
})
it('connects to a client newer than the verified version and says which version is running (ADR-0020)',async()=>{
 f=await grokFixture();await f.script({cliVersion:'1.0.40'})
 const snapshot=await f.host.connect()
 expect(snapshot.connected).toBe(true)
 expect(snapshot.version).toBe('1.0.40 / ACP 1')
 expect(snapshot.verifiedVersion).toBe('1.0.5')
})
it('rejects screenshots before sending when the native Grok client cannot accept images',async()=>{
 const id=await setup()
 expect((await f!.host.snapshot()).models.every(model=>model.supportsImages===false)).toBe(true)
 await expect(f!.host.execute({type:'send',threadId:id,commandId:'image',messageId:'image',text:'',attachments:[{
  id:'shot',name:'Screenshot.png',mimeType:'image/png',dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII=',
 }]})).rejects.toThrow('image support')
 expect((await f!.driver.requests()).some(request=>request.method==='session/prompt')).toBe(false)
})
it('filters API keys and keeps native home/auth paths without disabling coding tools',()=>{
 const env=grokEnvironment({PATH:'native-path',XAI_API_KEY:'must-not-copy',ANTHROPIC_API_KEY:'must-not-copy',GROK_HOME:'C:/native-grok',GROK_AUTH_PATH:'C:/native-auth.json'})
 expect(env.XAI_API_KEY).toBeUndefined();expect(env.ANTHROPIC_API_KEY).toBeUndefined();expect(env.GROK_HOME).toBe('C:/native-grok')
 expect(env.GROK_DISABLE_API_KEY_AUTH).toBe('1');expect(env.GROK_WRITE_FILE).toBeUndefined();expect(env.GROK_SUBAGENTS).toBeUndefined()
})
it('keeps live authored and streamed messages while durable history lags',async()=>{
 const id=await setup();await f!.script({historyVisibleCount:0});await send(id)
 expect((await f!.host.snapshot()).threads[0]!.messages).toContainEqual(expect.objectContaining({id:'own',role:'user',commandId:'own'}))
 await f!.action(id,{type:'chunk',text:'First '})
 await expect.poll(async()=>JSON.stringify((await f!.host.snapshot()).threads[0]!.messages)).toContain('First ')
 await f!.action(id,{type:'chunk',text:'second'})
 await expect.poll(async()=>JSON.stringify((await f!.host.snapshot()).threads[0]!.messages)).toContain('First second')
 await f!.script({});await f!.driver.completeTurn(id,'')
 await expect.poll(async()=>(await f!.host.snapshot()).threads[0]!.status).toBe('idle')
 const messages=(await f!.host.snapshot()).threads[0]!.messages
 expect(messages.filter(message=>message.role==='user')).toHaveLength(1);expect(messages.filter(message=>message.role==='assistant')).toHaveLength(1)
 expect(messages[1]!.text).toBe('First second')
})
it('keeps a live CLI takeover visible even before persistence catches up',async()=>{
 const id=await setup();await send(id);await f!.driver.completeTurn(id,'Done')
 await expect.poll(async()=>(await f!.host.snapshot()).threads[0]!.status).toBe('idle')
 await f!.script({historyVisibleCount:3})
 await f!.action(id,{type:'takeover',text:'External user input',notify:true})
 await expect.poll(async()=>(await f!.host.snapshot()).threads[0]!.messages.at(-1)?.text).toBe('External user input')
 expect((await f!.host.snapshot()).threads[0]!.status).toBe('running')
 await expect(send(id,'concurrent')).rejects.toThrow('already running')
 await expect(f!.host.execute({type:'send',threadId:id,commandId:'stale',messageId:'stale',text:'No',expectedLastUserMessageId:'own'})).rejects.toThrow('changed')
})
it.each([['end_turn','idle'],['sampling_error','error']] as const)('retains a live CLI %s outcome ahead of durable history',async(reason,status)=>{
 const id=await setup();await f!.action(id,{type:'takeover',text:'Native turn',notify:true})
 await expect.poll(async()=>(await f!.host.snapshot()).threads[0]!.status).toBe('running')
 await f!.script({historyVisibleCount:1})
 await f!.action(id,{type:'complete',text:'',reason})
 await expect.poll(async()=>(await f!.host.snapshot()).threads[0]!.status).toBe(status)
 expect((await f!.host.snapshot()).threads[0]!.status).toBe(status)
 await f!.script({});expect((await f!.host.snapshot()).threads[0]!.status).toBe(status)
 await f!.driver.typeInProvider(id,'A later persisted CLI turn')
 await expect.poll(async()=>(await f!.host.snapshot()).threads[0]!.status).toBe('running')
})
it('detects CLI takeover when native resume reuses event IDs',async()=>{
 const id=await setup();await f!.script({reusedEventIds:true});await send(id)
 await f!.driver.typeInProvider(id,'A different CLI-authored prompt')
 await expect.poll(async()=>(await f!.host.snapshot()).threads[0]!.messages.some(message=>message.text==='A different CLI-authored prompt'&&message.commandId===undefined)).toBe(true)
 await expect(f!.host.execute({type:'send',threadId:id,commandId:'stale',messageId:'stale',text:'No',expectedLastUserMessageId:'own'})).rejects.toThrow('changed')
})
it('rejects concurrent prompts and deduplicates acknowledged command identities',async()=>{
 const id=await setup();await send(id)
 expect(await send(id)).toEqual({accepted:true})
 await expect(send(id,'concurrent')).rejects.toThrow('already running')
 expect((await f!.driver.requests()).filter(request=>request.method==='session/prompt')).toHaveLength(1)
 const metadata=await readFile(join(f!.root,'grok-threads.json'),'utf8')
 expect(metadata).not.toContain('Synthetic prompt');expect(metadata).toContain('digest')
})
it('does not duplicate an uncertain creation, including after its late native response',async()=>{
 f=await grokFixture();await f.host.connect()
 await f.host.execute({type:'create-project',commandId:'project',projectId:'project',title:'Project',path:f.root});await f.script({delayCreate:3000})
 const command={type:'create-thread',commandId:'create',threadId:randomUUID(),projectId:'project',title:'Test',modelId:f.modelId} as const
 expect(await f.host.execute(command)).toEqual({accepted:false,uncertain:true});expect(await f.host.execute(command)).toEqual({accepted:false,uncertain:true})
 await expect.poll(async()=>(await f!.host.snapshot()).threads[0]?.modelId).toBe(f.modelId)
 expect(await f.realId(command.threadId)).toBeTruthy()
 expect(await f.host.execute(command)).toEqual({accepted:false,uncertain:true})
 expect((await f.driver.requests()).filter(request=>request.method==='session/new')).toHaveLength(1)
 await expect(send(command.threadId)).rejects.toThrow('not confirmed')
})
it('blocks prompt delivery when native model selection was rejected',async()=>{
 f=await grokFixture();await f.host.connect();await f.host.execute({type:'create-project',commandId:'project',projectId:'project',title:'Project',path:f.root});await f.script({rejectModel:true})
 const command={type:'create-thread',commandId:'create',threadId:randomUUID(),projectId:'project',title:'Test',modelId:f.modelId} as const
 await expect(f.host.execute(command)).rejects.toThrow('rejected')
 expect((await f.host.snapshot()).threads[0]!.status).toBe('error');await expect(send(command.threadId)).rejects.toThrow('not confirmed')
 expect((await f.driver.requests()).some(request=>request.method==='session/prompt')).toBe(false)
})
it('rechecks takeover after persisting an origin and rolls back the undispatched command',async()=>{
 const id=await setup()
 const seam=f!.adapter as unknown as {persist():Promise<void>}
 const original=seam.persist.bind(f!.adapter);let injected=false
 seam.persist=async()=>{
  await original()
  if(!injected){injected=true;await f!.driver.typeInProvider(id,'CLI input during origin persistence');await expect.poll(async()=>(await f!.host.snapshot()).threads[0]!.messages.at(-1)?.text).toBe('CLI input during origin persistence')}
 }
 await expect(f!.host.execute({type:'send',threadId:id,commandId:'stale',messageId:'stale',text:'Automatic follow-up',expectedLastUserMessageId:null})).rejects.toThrow('changed')
 expect((await f!.driver.requests()).some(request=>request.method==='session/prompt')).toBe(false)
 expect(await readFile(join(f!.root,'grok-threads.json'),'utf8')).not.toContain('"messageId": "stale"')
})
it('reconnects the same host instance after a turn without stale running state',async()=>{
 const id=await setup();await send(id);f!.host.disconnect();await f!.adapter.closed()
 f!.host.observeThreads?.([id]);await f!.host.connect()
 await f!.driver.completeTurn(id,'Done')
 await expect.poll(async()=>(await f!.host.snapshot()).threads[0]!.status).toBe('idle')
 expect((await f!.host.snapshot()).threads[0]!.messages.filter(message=>message.role==='user')).toHaveLength(1)
})
it('preserves Sotto identity across native session restart through the registry wrapper',async()=>{
 f=await grokFixture();let registry=new ThreadRegistry(f.root);let wrapper=new SottoThreadHost('grok',f.adapter,registry)
 await wrapper.connect();await wrapper.execute({type:'create-project',commandId:'project',projectId:'project',title:'Project',path:f.root})
 const sottoId=randomUUID();await wrapper.execute({type:'create-thread',commandId:'create',threadId:sottoId,projectId:'project',title:'Wrapped',modelId:f.modelId})
 const providerAlias=registry.byThread(sottoId)!.sessionId;const nativeId=await f.realId(providerAlias)
 expect(nativeId).not.toBe(providerAlias);expect(providerAlias).not.toBe(sottoId)
 await wrapper.execute({type:'send',threadId:sottoId,commandId:'wrapped-send',messageId:'wrapped-own',text:'Wrapped prompt'})
 wrapper.disconnect();await f.adapter.closed();await registry.flush()
 f=await f.driver.restart();registry=new ThreadRegistry(f.root);wrapper=new SottoThreadHost('grok',f.adapter,registry)
 const resumed=await wrapper.connect()
 expect(resumed.threads[0]!.id).toBe(sottoId);expect(registry.byThread(sottoId)!.sessionId).toBe(providerAlias);expect(await f.realId(providerAlias)).toBe(nativeId)
 expect(JSON.stringify(resumed)).not.toContain(nativeId)
 wrapper.disconnect();await f.adapter.closed();await registry.flush()
})
it('publishes a lost connection for malformed native frames',async()=>{
 const id=await setup();await f!.action(id,{type:'malformed'})
 await expect.poll(async()=>(await f!.host.snapshot()).connected).toBe(false)
})
it('closes the proxy barrier when a surviving leader inherits output handles',async()=>{
 const id=await setup();await f!.action(id,{type:'inherited-exit'})
 await expect.poll(async()=>(await f!.host.snapshot()).connected).toBe(false)
 await f!.adapter.closed()
})
it('reads a page of history larger than a megabyte instead of losing the connection',async()=>{
 // `_x.ai/session/updates` answers with a whole page of durable history on one line, carrying whatever
 // that session's tools printed: a real project thread measured 1.5 MB, 2.6 MB and 1.6 MB across three
 // of its four pages. A transport that failed above a megabyte refused every connection that read one.
 const id=await setup();await send(id);await f!.driver.completeTurn(id,'Answer')
 await expect.poll(async()=>(await f!.host.snapshot()).threads[0]!.status).toBe('idle')
 await f!.script({historyPadBytes:1_200_000})
 await f!.host.refreshThread(id)
 const snapshot=await f!.host.snapshot()
 expect(snapshot.connected).toBe(true)
 expect(snapshot.threads[0]!.messages.at(-1)!.text).toBe('Answer')
})
it('says the connection was lost, and never blames the version, when the client stops answering',async()=>{
 // The version and the sign-in are what the old wording blamed for every failure, including this one,
 // where the client had already answered `initialize` with a version Sotto accepts.
 f=await grokFixture();await f.script({ignoreAuthenticate:true})
 const error=await f.host.connect().then(()=>undefined,(reason:Error)=>reason)
 expect(error?.message).toBe('Could not connect Grok. Grok did not acknowledge the operation in time. Connect again to retry.')
 expect(error?.message).not.toContain('Grok CLI')
})
