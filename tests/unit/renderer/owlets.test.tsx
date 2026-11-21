// ADR-0210: owlets live only on their own page, which the room switch reaches while the Owl feature is on; the setup makes
// one on a computer that lists `owlets`, on Claude Code or Codex.
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentCommand, AgentModel, AgentState } from '../../../src/shared/agents'
import { appRooms, layoutFor, roomFor } from '../../../src/renderer/src/components/AppShell'
import { withoutOwlets } from '../../../src/shared/owletVisibility'
import { owletInstructions, owletNameProblem, sameOwletName } from '../../../src/shared/owlets'
import { owletOrder } from '../../../src/renderer/src/features/owlets/OwletsView'
import { owletLook } from '../../../src/renderer/src/features/owlets/OwletMark'
import { OwletSetup, owletHomes, owletModels } from '../../../src/renderer/src/features/owlets/OwletSetup'
import type { ThreadRow } from '../../../src/renderer/src/agents/threadFacts'
import { threadsStateFixture } from '../../fixtures/agentState'

afterEach(cleanup)

const LOCAL = '11111111-1111-4111-8111-111111111111', FORGE = '22222222-2222-4222-8222-222222222222'
const model = (patch: Partial<AgentModel>): AgentModel => ({ id: 'claude:sonnet', provider: 'Claude', providerId: 'claude', name: 'Sonnet', ready: true, runtimeModes: ['approval-required', 'full-access'], ...patch })

function state(): AgentState {
  return threadsStateFixture({
    projects: [{ id: 'owl-folder', title: 'Tawny', path: '/data/owlets/Tawny' }, { id: 'work', title: 'Work', path: '/work' }],
    threads: [
      { id: 'tawny', projectId: 'owl-folder', title: 'Tawny', owlet: { name: 'Tawny', role: 'Keeps my inbox' } },
      { id: 'task', projectId: 'work', title: 'A task' },
    ],
    host: { models: [model({}), model({ id: 'codex:gpt', provider: 'Codex', providerId: 'codex', name: 'GPT' }), model({ id: 'grok:4', provider: 'Grok', providerId: 'grok', name: 'Grok 4' })] },
    topLevel: { activeThreadId: 'tawny', activeProjectId: 'owl-folder',
      connections: [{ hostId: FORGE, name: 'forge', kind: 'remote', connected: true }, { hostId: LOCAL, name: 'laptop', kind: 'local', connected: true, owlets: true }] },
  })
}

describe('the Owlets room', () => {
  it('comes after Threads only while its Owl feature is on, and owns the window', () => {
    expect(appRooms({ watcher: true, owlets: true, dictation: true }).map(room => room.id)).toEqual(['dictate', 'watcher', 'threads', 'owlets'])
    expect(appRooms({ watcher: true, dictation: true }).map(room => room.id)).toEqual(['dictate', 'watcher', 'threads'])
    expect(roomFor('owlets')).toBe('owlets')
    expect(layoutFor('owlets', false)).toBe('page')
  })
})

describe('withoutOwlets', () => {
  it('leaves every owlet, its folder and a selection of it out of the Threads page, and the rest as it was', () => {
    const shown = withoutOwlets(state())
    expect(shown.host.threads.map(thread => thread.id)).toEqual(['task'])
    expect(shown.host.projects.map(project => project.id)).toEqual(['work'])
    expect([shown.activeThreadId, shown.activeProjectId]).toEqual([null, null])
    const plain = threadsStateFixture()
    expect(withoutOwlets(plain)).toBe(plain)
  })
})

describe('owletInstructions', () => {
  it('tells an owlet its name and the role in the user\'s words, and that it answers no card of its own', () => {
    const told = owletInstructions({ name: 'Tawny', role: 'Keeps my inbox' })
    expect(told).toContain('You are Tawny, an owlet')
    expect(told).toContain("Your role, in the user's words: Keeps my inbox")
    expect(told).toContain('you never answer your own')
    expect(owletInstructions({ name: 'Elf', role: '' })).not.toContain('Your role')
  })
})

describe('owlet names', () => {
  it('takes letters written with marks, and one Unicode form for two spellings of a name', () => {
    for (const name of ['राम', 'தமிழ்', 'తెలుగు', 'বাংলা', 'Cafe\u0301', 'Tawny Owl']) expect(owletNameProblem(name)).toBeUndefined()
    expect(sameOwletName('Cafe\u0301', 'Caf\u00e9')).toBe(true)
    expect(owletNameProblem('\u0301ab')).toBe('characters')
    expect(owletNameProblem('con')).toBe('characters')
  })
})

describe('the rows', () => {
  it('gives each owlet the same face in every window, whatever its host calls it, and lists the newest first', () => {
    const id = '5f0c3a9e-8d2b-4c71-9a10-2b3c4d5e6f70'
    expect(owletLook(`host:${LOCAL}:${id}`)).toEqual(owletLook(id))
    const looks = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(suffix => JSON.stringify(owletLook(`${id.slice(0, -1)}${suffix}`))))
    expect(looks.size).toBeGreaterThan(1)
    const row = (id: string, activityAt: number) => ({ thread: { id, title: id }, activityAt }) as unknown as ThreadRow
    expect(owletOrder([row('Elf', Number.NaN), row('Barn', 10), row('Scops', 20), row('Aka', Number.NaN)]).map(item => item.thread.id)).toEqual(['Scops', 'Barn', 'Aka', 'Elf'])
  })
})

describe('OwletSetup', () => {
  it('offers only the computers that make owlets, and only Claude Code and Codex there', () => {
    const current = state()
    expect(owletHomes(current)).toEqual([{ hostId: LOCAL, name: 'This computer' }])
    expect(owletModels(current, LOCAL).map(item => item.id)).toEqual(['claude:sonnet', 'codex:gpt'])
  })

  it('makes an owlet on its home computer and opens it', async () => {
    const sent: AgentCommand[] = []
    const command = vi.fn(async (next: AgentCommand) => { sent.push(next); return { ...state(), error: null } })
    const made = vi.fn()
    render(<OwletSetup state={state()} command={command} onClose={() => undefined} onMade={made} />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Scops' } })
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'Keeps the repos tidy' } })
    expect(screen.getByText(/Its folder: Owlets\/Scops on this computer/u)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Make owlet' }))
    await waitFor(() => expect(made).toHaveBeenCalled())
    expect(sent[0]).toMatchObject({ type: 'create-owlet', name: 'Scops', role: 'Keeps the repos tidy', modelId: 'claude:sonnet' })
    expect((sent[0] as { threadId: string }).threadId).toMatch(new RegExp(`^host:${LOCAL}:`, 'u'))
    expect(made).toHaveBeenCalledWith((sent[0] as { threadId: string }).threadId)
  })

  it('says why a name can\'t be used and keeps Make owlet off', () => {
    render(<OwletSetup state={state()} command={vi.fn()} onClose={() => undefined} onMade={() => undefined} />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'a/b' } })
    expect(screen.getByText('Use letters, numbers, spaces and hyphens in the name.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Make owlet' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows the refusal its home computer gives, and makes nothing more', async () => {
    const command = vi.fn(async () => ({ ...state(), error: 'An owlet on this computer has that name, or a folder by that name. Choose another name. Nothing was changed.' }))
    const made = vi.fn()
    render(<OwletSetup state={state()} command={command} onClose={() => undefined} onMade={made} />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Owl two' } })
    fireEvent.click(screen.getByRole('button', { name: 'Make owlet' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('or a folder by that name')
    expect(made).not.toHaveBeenCalled()
  })
})
