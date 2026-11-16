// @vitest-environment node
// Opt-in only: creates a fresh native Grok session and sends one text-only synthetic prompt.
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { GrokAcpHost } from '../../src/main/agents/grok'
import { findGrokExecutable, grokEnvironment } from '../../src/main/agents/grokRpc'
describe("requires SOTTO_GROK_LIVE=1", () => {
  it.skipIf(process.env.SOTTO_GROK_LIVE !== '1')('native Grok creates, prompts, and resumes an owned synthetic session', async () => {
   const root = await mkdtemp(join(tmpdir(),'sotto-grok-live-'))
   let host = new GrokAcpHost(root,{pollIntervalMs:1000})
   try {
    const initial = await host.connect()
    // The pin is a floor, not an exact version (ADR-0042): whatever is installed reports itself here.
    expect(initial.version).toContain(' / ACP 1')
    const threadId = randomUUID()
    await host.execute({type:'create-project',commandId:randomUUID(),projectId:'smoke',title:'Synthetic smoke',path:root})
    await host.execute({type:'create-thread',commandId:randomUUID(),threadId,projectId:'smoke',title:'Sotto synthetic adapter smoke',modelId:initial.models[0]!.id})
    expect(await host.execute({type:'send',commandId:randomUUID(),threadId,messageId:'smoke-prompt',text:'Reply with exactly SOTTO_GROK_SMOKE. Do not use tools, read files, or execute commands.'})).toEqual({accepted:true})
    // Disconnect immediately after authored echo, while the model turn is still in progress.
    expect((await host.snapshot()).threads[0]!.status).toBe('running')
    host.disconnect();await host.closed();host=new GrokAcpHost(root,{pollIntervalMs:1000});await host.connect()
    await expect.poll(async()=> (await host.snapshot()).threads[0]!.status,{timeout:90000,interval:1000}).toBe('idle')
    await expect.poll(async()=> (await host.snapshot()).threads[0]!.messages.some(message=>message.role==='assistant'&&message.text.includes('SOTTO_GROK_SMOKE')),{timeout:10000,interval:500}).toBe(true)
    let before = (await host.snapshot()).threads[0]!
    expect(before.messages.some(message=>message.role==='assistant'&&message.text.includes('SOTTO_GROK_SMOKE'))).toBe(true)
    expect(before.messages.filter(message=>message.role==='user')).toHaveLength(1)
    const aliases=JSON.parse(await readFile(join(root,'grok-threads.json'),'utf8'))
    const nativeId=aliases[threadId].grokSessionId as string
    const cli=promisify(execFile)((await findGrokExecutable())!,['--cwd',root,'--permission-mode','default','--resume',nativeId,'--single','Reply exactly SOTTO_CLI_TAKEOVER. Do not use tools, read files, or execute commands.'],{cwd:root,env:grokEnvironment(),windowsHide:true,timeout:60000,maxBuffer:1024*1024})
    const cliResult=await cli
    expect(cliResult.stdout).toContain('SOTTO_CLI_TAKEOVER')
    await expect.poll(async()=>(await host.snapshot()).threads[0]!.messages.some(message=>message.role==='user'&&message.text.includes('SOTTO_CLI_TAKEOVER')&&message.commandId===undefined),{timeout:30000,interval:500}).toBe(true)
    await expect(host.execute({type:'send',threadId,commandId:'stale',messageId:'stale',text:'Stale automatic reply',expectedLastUserMessageId:'smoke-prompt'})).rejects.toThrow('changed')
    await expect.poll(async()=>(await host.snapshot()).threads[0]!.status,{timeout:10000,interval:500}).toBe('idle')
    before=(await host.snapshot()).threads[0]!
    host.disconnect();await host.closed()
    host = new GrokAcpHost(root)
    expect((await host.connect()).threads[0]).toEqual(before)
   } finally {host.disconnect();await host.closed();await rm(root,{recursive:true,force:true})}
  },120000)
  // #2633: a subagent Grok runs in the background is the thread's background work from when the turn ends until Grok says
  // it finished and has reported it. The user's presses are stood in for: each card is allowed once.
  it.skipIf(process.env.SOTTO_GROK_LIVE !== '1')('native Grok keeps a background subagent as background work until it finishes', async () => {
   const root = await mkdtemp(join(tmpdir(),'sotto-grok-live-'))
   const host = new GrokAcpHost(root,{pollIntervalMs:1000})
   const seen: string[] = []
   try {
    const initial = await host.connect()
    const threadId = randomUUID()
    await host.execute({type:'create-project',commandId:randomUUID(),projectId:'smoke',title:'Synthetic smoke',path:root})
    await host.execute({type:'create-thread',commandId:randomUUID(),threadId,projectId:'smoke',title:'Background subagent',modelId:initial.models[0]!.id})
    host.observeThreads?.([threadId])
    expect(await host.execute({type:'send',commandId:randomUUID(),threadId,messageId:'background-prompt',text:'Start exactly one subagent in the background (do not wait for it). Its task: run the shell command `sleep 30` and then write the word done to a file named done.txt. As soon as it has started, end your turn with one short sentence. Do not wait for it and do not check on it.'})).toEqual({accepted:true})
    const answered = new Set<string>()
    const look = async () => {
     const thread = (await host.snapshot()).threads[0]!
     for (const request of thread.requests) if (!answered.has(request.id)) { answered.add(request.id); void host.execute({type:'answer',commandId:randomUUID(),threadId,requestId:request.id,answer:'Allow once',approved:true}).catch(() => undefined) }
     const state = `${thread.status} work=${(thread.backgroundWork ?? []).map(work => `${work.type}:${work.label}`).join(',')} rows=${(thread.activities ?? []).filter(row => row.kind === 'subagent').map(row => `${row.status}/${row.agents?.[0]?.status}`).join(',')}`
     if (seen.at(-1) !== state) seen.push(state)
     return thread
    }
    await expect.poll(async () => { const thread = await look(); return thread.status === 'idle' && (thread.backgroundWork ?? []).some(work => work.type === 'subagent') }, {timeout:120000,interval:500}).toBe(true)
    await expect.poll(async () => { const thread = await look(); return thread.status === 'idle' && !(thread.backgroundWork ?? []).some(work => work.type === 'subagent') }, {timeout:180000,interval:1000}).toBe(true)
    expect((await look()).activities?.find(row => row.kind === 'subagent')).toMatchObject({ status: 'completed', agents: [{ status: 'completed' }] })
   } finally {console.log(seen.join('\n'));host.disconnect();await host.closed();await rm(root,{recursive:true,force:true})}
  },360000)
})
