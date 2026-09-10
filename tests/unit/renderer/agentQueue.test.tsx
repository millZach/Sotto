import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import React from 'react'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import type { AgentBridge } from '../../../src/shared/agents'
import { useAgentConnection } from '../../../src/renderer/src/agents/AgentContext'
import { AgentComposer, AgentQueue } from '../../../src/renderer/src/agents/AgentView'

const directories: string[] = []
const controls: AgentControl[] = []

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-answer-ui-'))
  directories.push(directory)
  const credentials = new AgentCredentials(directory, {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value),
    decryptString: value => value.toString('utf8'),
  })
  await credentials.load()
  const host = new E2EAgentHost()
  let control: AgentControl
  const start = async (): Promise<void> => {
    control = new AgentControl({ directory, host, credentials, reasoner: e2eAgentReasoner,
      membership: {
        status: async () => ({ status: 'beta', label: 'Fixture beta', expiresAt: null }),
        action: async () => ({ status: 'beta', label: 'Fixture beta', expiresAt: null }),
      } })
    controls.push(control)
    await control.start()
    if (!control.get().host.connected) await control.command({ type: 'connect' })
  }
  await start()
  await control!.command({ type: 'assign', threadId: 'workshop' })
  await control!.command({ type: 'assign', threadId: 'docs' })
  host.event({ type: 'question', threadId: 'workshop', text: 'Choose the workshop colors.', requestId: 'workshop-colors' })
  host.event({ type: 'question', threadId: 'docs', text: 'Choose the guide format.', requestId: 'docs-format' })
  await control!.command({ type: 'select-thread', threadId: 'workshop' })
  return {
    host,
    get control() { return control },
    get bridge(): AgentBridge { return { get: async () => control.get(), command: request => control.command(request), onState: listener => control.subscribe(listener) } },
    async restart() { control.dispose(); await start() },
  }
}

function Surface({ bridge, compact = false }: { readonly bridge: AgentBridge; readonly compact?: boolean }) {
  const { state, command } = useAgentConnection(bridge)
  if (state === null) return null
  return <><AgentQueue state={state} command={command} compact={compact} /><AgentComposer state={state} command={command} compact={compact} /></>
}

afterEach(async () => {
  cleanup()
  for (const control of controls.splice(0)) control.dispose()
  for (const directory of directories.splice(0)) {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('sotto-answer-ui-')) throw new Error('Unexpected answer test directory')
    await rm(directory, { recursive: true, force: true })
  }
})

describe('durable typed queue answers', () => {
  it('saves one request-bound answer across queue navigation, both surfaces, and restart', async () => {
    const f = await fixture()
    const bridge = f.bridge
    const main = render(<Surface bridge={bridge} />)
    const widget = render(<Surface bridge={bridge} compact />)
    const mainUi = within(main.container)
    const widgetUi = within(widget.container)
    const input = await mainUi.findByLabelText('Your answer')
    expect(mainUi.getAllByRole('textbox')).toHaveLength(1)
    fireEvent.change(input, { target: { value: 'Use the existing indigo palette.' } })
    await waitFor(() => expect(f.control.get()).toMatchObject({
      draft: 'Use the existing indigo palette.', draftThreadId: 'workshop', draftRequestId: 'workshop-colors', composing: true, busy: false,
    }))
    await waitFor(() => expect(widgetUi.getByLabelText('Your answer')).toHaveValue('Use the existing indigo palette.'))
    for (const name of ['Later', 'Next']) {
      fireEvent.click(mainUi.getByRole('button', { name, exact: true }))
      await waitFor(() => expect(f.control.get().error).toMatch(/send or clear your draft/iu))
      expect(f.control.get().activeThreadId).toBe('workshop')
      expect(mainUi.getByLabelText('Your answer')).toHaveValue('Use the existing indigo palette.')
      await waitFor(() => expect(f.control.get().busy).toBe(false))
    }
    fireEvent.click(mainUi.getByRole('button', { name: 'Docs', exact: true }))
    await waitFor(() => expect(f.control.get().activeThreadId).toBe('docs'))
    expect(mainUi.getByLabelText('Your answer')).toHaveValue('Use the existing indigo palette.')
    expect(mainUi.getByText('This draft stays with Workshop.')).toBeInTheDocument()
    fireEvent.change(widgetUi.getByLabelText('Your answer'), { target: { value: 'Use indigo with white text.' } })
    await waitFor(() => expect(mainUi.getByLabelText('Your answer')).toHaveValue('Use indigo with white text.'))
    expect(f.control.get()).toMatchObject({ draftThreadId: 'workshop', draftRequestId: 'workshop-colors' })
    await waitFor(() => expect(f.control.get().busy).toBe(false))
    main.unmount(); widget.unmount()
    await f.restart()
    const restored = render(<Surface bridge={f.bridge} />)
    expect(await within(restored.container).findByLabelText('Your answer')).toHaveValue('Use indigo with white text.')
    expect(f.control.get()).toMatchObject({ draftThreadId: 'workshop', draftRequestId: 'workshop-colors', composing: true })
  })

  it('keeps an answer after a rejected send and clears it after confirmed delivery', async () => {
    const f = await fixture()
    const view = render(<Surface bridge={f.bridge} />)
    const ui = within(view.container)
    fireEvent.change(await ui.findByLabelText('Your answer'), { target: { value: 'Use indigo.' } })
    await waitFor(() => expect(f.control.get()).toMatchObject({ draft: 'Use indigo.', busy: false }))
    await waitFor(() => expect(ui.getByRole('button', { name: 'Send it' })).toBeEnabled())
    f.host.event({ type: 'reject', text: 'Fixture answer rejected' })
    fireEvent.click(ui.getByRole('button', { name: 'Send it' }))
    await waitFor(() => expect(f.control.get().error).toBe('Fixture answer rejected'))
    expect(ui.getByLabelText('Your answer')).toHaveValue('Use indigo.')
    await waitFor(() => expect(ui.getByRole('button', { name: 'Send it' })).toBeEnabled())
    fireEvent.click(ui.getByRole('button', { name: 'Send it' }))
    await waitFor(() => expect(f.control.get()).toMatchObject({ draft: '', draftThreadId: null, draftRequestId: null, composing: false, busy: false }))
    expect(f.control.get().host.threads.find(thread => thread.id === 'workshop')?.requests).toHaveLength(0)
    expect(f.control.get().host.threads.find(thread => thread.id === 'docs')?.requests).toHaveLength(1)
    await waitFor(() => expect(ui.getByLabelText('Your answer')).toHaveValue(''))
  })
})
