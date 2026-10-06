import React from 'react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { startHeadlessHost } from '../../src/host'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { AgentComposer } from '../../src/renderer/src/agents/AgentView'
import type { AgentCommand } from '../../src/shared/agents'

afterEach(cleanup)

it('keeps successive socket edits active in the managed composer and sends the picked draft', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-socket-composer-'))
  const host = await startHeadlessHost({ dataDirectory: root, port: 0,
    providers: { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost() }, reasoner: e2eAgentReasoner })
  let client: SocketHostService | undefined
  try {
    const url = 'http://127.0.0.1:' + host.descriptor!.port
    const paired = await SocketHostService.pair(url, host.pairing.issuePairingCode().code, 'Composer client')
    client = new SocketHostService({ url, token: paired.token, expectedHostId: paired.hostId })
    await client.connect()
    await client.command({ type: 'connect', provider: 'codex' })
    const local = client.shell().host.threads[0]!
    const created = await client.command({ type: 'create-project', provider: 'codex', title: 'Remote project', path: root, useExisting: true })
    const projectId = created.host.projects.find(project => project.path === root)!.id
    const opened = await client.command({ type: 'create-thread', projectId, title: 'Remote thread', modelId: created.host.models[0]!.id, managed: true })
    const remote = opened.host.threads.find(thread => thread.title === 'Remote thread')!
    await host.service.command({ type: 'pause-draft' }, desktopWindowClient())
    expect(host.service.shell()).toMatchObject({ composing: false, draftThreadId: null })
    await client.command({ type: 'select-thread', threadId: remote!.id })
    const calls: { type: string; error: string | null }[] = []
    const command = async (input: AgentCommand) => { const result = await client!.command(input); calls.push({ type: input.type, error: result.error }); return result }
    const view = render(<AgentComposer state={client.shell()} command={command} />)
    const unsubscribe = client.subscribe(state => { view.rerender(<AgentComposer state={state} command={command} />) })
    try {
      await act(async () => {
        fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'First edit' } })
        await expect.poll(() => client!.shell().draft).toBe('First edit')
      })
      expect(screen.getByRole('textbox', { name: 'Prompt' })).not.toHaveAttribute('readonly')
      expect(screen.queryByRole('button', { name: 'Resume draft' })).not.toBeInTheDocument()
      await host.service.command({ type: 'select-thread', threadId: local!.id }, desktopWindowClient())
      await act(async () => { await host.service.command({ type: 'compose', text: 'Host draft' }, desktopWindowClient()) })
      await act(async () => {
        fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), { target: { value: 'Second edit' } })
        await expect.poll(() => client!.shell().draft).toBe('Second edit')
      })
      expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Second edit')
      await act(async () => {
        expect(screen.getByRole('button', { name: 'Send it' })).not.toBeDisabled()
        fireEvent.click(screen.getByRole('button', { name: 'Send it' }))
        await expect.poll(() => calls.some(call => call.type === 'send')).toBe(true)
        expect(calls).toEqual(expect.arrayContaining([{ type: 'send', error: null }]))
        expect(host.service.threadDetail(remote!.id)!.messages).toContainEqual(expect.objectContaining({ role: 'user', text: 'Second edit' }))
      })
      expect(host.service.shell()).toMatchObject({ draft: 'Host draft', draftThreadId: local!.id })
      expect(host.service.shell().threadDrafts).toContainEqual(expect.objectContaining({ threadId: local!.id, text: 'Host draft' }))
    } finally { unsubscribe(); view.unmount() }
  } finally { await client?.close(); await host.close(); await rm(root, { recursive: true, force: true }) }
})
