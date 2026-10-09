import { hostsBridgeFixture, hostStatus } from '../../fixtures/renderer/hostBridges'
import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { CommandLines } from '../../../src/renderer/src/features/settings/HostClientUpdates'
import { HostProviderSignIn } from '../../../src/renderer/src/features/settings/HostProviderSignIn'
import { HostProviders } from '../../../src/renderer/src/features/settings/HostProviders'
import { HostSetupChecklist } from '../../../src/renderer/src/features/settings/HostSetupChecklist'
import type { HostStatus } from '../../../src/shared/hosts'
import type { AgentProviderStatus } from '../../../src/shared/agents'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const host: HostStatus = hostStatus({ id: 'host', name: 'forge', target: 'forge', identityFile: '', installPath: '/opt/sotto', dataDirectory: '/data', phase: 'connected', enabled: true })
delete host.hostId

it.each(['update command', 'sign-in code', 'Devin command', 'setup fix'] as const)('copies the Settings %s through main when browser clipboard access is denied', async surface => {
  const user = userEvent.setup()
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Permission denied'))
  const deliverOutput = vi.fn(async () => 'copied')
  vi.stubGlobal('sotto', { deliverOutput })
  let text: string, name: string
  if (surface === 'update command') {
    text = 'mise upgrade codex\ncode --version'; name = 'Copy the command that updates Codex on forge'
    render(<CommandLines lead="Run on forge" lines={text.split('\n')} name="Codex" host="forge" />)
  } else if (surface === 'sign-in code') {
    text = 'ABCD-EFGH'; name = 'Copy the code'
    const bridge = hostsBridgeFixture({ commands: { signIn: vi.fn(async () => ({ id: 'sign-in', provider: 'codex' as const, shape: 'device-code' as const, stage: 'waiting' as const, code: text, page: 'auth.openai.com' })) } }).bridge
    render(<HostProviderSignIn host={host} provider="codex" bridge={bridge} onClose={() => undefined} />)
  } else if (surface === 'Devin command') {
    text = 'devin auth login --force-manual-token-flow'; name = 'Copy the Devin sign-in command'
    const provider = { id: 'devin', name: 'Devin', version: '', connection: 'error', problem: 'signed-out', capabilities: {} } as AgentProviderStatus
    render(<HostProviders host={host} bridge={hostsBridgeFixture({ commands: {} }).bridge} providers={[provider]} />)
    await user.click(screen.getByRole('button', { name: 'Show providers on forge' }))
  } else {
    text = 'ssh-keygen -R forge'; name = 'Copy the command'
    render(<HostSetupChecklist name="forge" summary="SSH" host={{ ...host, phase: 'error', step: 'sign-in', fix: { text: 'Remove the old key', command: text } }} outcome="failed" error="SSH refused the key" onOpenApproval={() => undefined} onOpenGuide={() => undefined} />)
  }
  await user.click(await screen.findByRole('button', { name }))
  await waitFor(() => expect(screen.getByRole('button', { name })).toHaveTextContent('Copied'))
  expect(deliverOutput).toHaveBeenCalledWith({ text, autoPaste: false, pasteDelayMs: 50 })
  expect(writeText).not.toHaveBeenCalled()
})
