import React from 'react'
import { randomUUID } from 'node:crypto'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AddOwnServerDialog, OwnModelServers, ownServerName, parseContext } from '../../../src/renderer/src/agents/OwnModelServers'
import { type OwnServer, type OwnServersBridge, type FoundModel } from '../../../src/shared/ownModelServers'

const models: FoundModel[] = [
  { id: 'one', name: 'One', context: 128000, thinking: true, reasoningEfforts: ['none', 'low', 'high'], images: true, tools: true, cost: { input: 0, output: 3 } },
  { id: 'two', name: 'Two', context: 64000, thinking: true, reasoningEfforts: ['default'], images: false },
]
const server: OwnServer = { id: 'own-test', name: 'Example', address: 'https://example.test/v1', keyed: true, keyKeeper: 'hermes',
  models: models.map(model => ({ ...model, context: model.context!, thinking: true, images: !!model.images })), inventory: models, keptModelIds: ['one'] }
function fake(overrides: Partial<OwnServersBridge> = {}): OwnServersBridge {
  return { catalogue: vi.fn(async () => ({ available: true, entries: [{ id: 'example', name: 'Example', api: server.address, doc: 'https://example.test/docs' }] })),
    list: vi.fn(async () => [server]), check: vi.fn(async () => ({ status: 'ok' as const, address: server.address, kind: 'openai-compatible' as const, answeredMs: 1, models })),
    add: vi.fn(async () => ({ status: 'ok' as const, server })), chooseModels: vi.fn(async () => ({ status: 'ok' as const, server })),
    replaceKey: vi.fn(async () => ({ status: 'ok' as const, server })), checkSaved: vi.fn(async () => ({ status: 'ok' as const, address: server.address, kind: 'openai-compatible' as const, answeredMs: 1, models })),
    remove: vi.fn(async () => ({ status: 'ok' as const })), ...overrides }
}
afterEach(cleanup)
async function choose(bridge = fake()) {
  render(<AddOwnServerDialog bridge={bridge} onClose={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Example' }))
  fireEvent.change(screen.getByLabelText('Key'), { target: { value: randomUUID() } })
  fireEvent.click(screen.getByRole('button', { name: 'Check key' }))
  await screen.findByRole('checkbox', { name: 'One' })
  return bridge
}
describe('the approved API dialog', () => {
  it('keeps server name and context parsing compatible', () => {
    expect(ownServerName('spark-head.tail123.ts.net:8888')).toBe('spark-head')
    expect(ownServerName('localhost:11434', 'ollama')).toBe('Ollama')
    expect(parseContext('128K')).toBe(131072)
    expect(parseContext('1M')).toBe(1048576)
    expect(parseContext('512')).toBeNull()
  })
  it('downloads the catalogue on opening, and keeps Another address after failure', async () => {
    const bridge = fake({ catalogue: vi.fn(async () => ({ available: false, entries: [] })) })
    render(<AddOwnServerDialog bridge={bridge} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Another address' }))
    expect(screen.getByLabelText('Address')).toBeTruthy()
    expect(bridge.catalogue).toHaveBeenCalledTimes(1)
  })
  it('starts a small inventory selected without search or filters, and reads exact IDs and Details', async () => {
    await choose()
    expect(screen.queryByRole('textbox', { name: 'Search models' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Selected/ })).toBeNull()
    expect((screen.getByRole('checkbox', { name: 'One' }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText('one')).toBeTruthy()
    fireEvent.click(screen.getAllByText('Details')[0]!)
    expect(screen.getByText(/Input:.*\$0 per 1M tokens/)).toBeTruthy()
    expect(screen.getByText(/the model’s default/)).toBeTruthy()
  })
  it('starts more than ten unselected and scopes bulk choices to search', async () => {
    const many = Array.from({ length: 14 }, (_, index) => ({ ...models[0]!, id: `m${index}`, name: `Model ${index}` }))
    const bridge = fake({ check: vi.fn(async () => ({ status: 'ok' as const, address: server.address, kind: 'openai-compatible' as const, answeredMs: 1, models: many })) })
    render(<AddOwnServerDialog bridge={bridge} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Example' }))
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: randomUUID() } })
    fireEvent.click(screen.getByRole('button', { name: 'Check key' }))
    const search = await screen.findByRole('textbox', { name: 'Search models' })
    expect(screen.getByRole('button', { name: 'Add 0 models' })).toBeDisabled()
    fireEvent.change(search, { target: { value: 'm13' } })
    fireEvent.click(screen.getByRole('button', { name: 'Select shown' }))
    expect(screen.getByText('1 of 14 models selected')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'Model 13' })).toBeChecked()
  })
  it('only asks for missing context, and does not save guessed facts', async () => {
    const bridge = fake({ check: vi.fn(async () => ({ status: 'ok' as const, address: server.address, kind: 'openai-compatible' as const, answeredMs: 1, models: [{ id: 'unknown', name: 'Unknown' }] })) })
    render(<AddOwnServerDialog bridge={bridge} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Another address' }))
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: server.address } })
    fireEvent.click(screen.getByRole('button', { name: 'Check this server' }))
    const context = await screen.findByLabelText(/Context, in tokens/)
    fireEvent.change(context, { target: { value: '128K' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 models' }))
    await waitFor(() => expect(bridge.add).toHaveBeenCalled())
    expect(vi.mocked(bridge.add).mock.calls[0]![0].models[0]).toMatchObject({ context: 131072, reasoningEfforts: ['default'] })
  })
  it('saves only chosen IDs while retaining the full inventory', async () => {
    const bridge = await choose()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Two' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 models' }))
    await waitFor(() => expect(bridge.add).toHaveBeenCalled())
    expect(vi.mocked(bridge.add).mock.calls[0]![0]).toMatchObject({ keptModelIds: ['one'], inventory: models })
  })
  it('changes kept models in the existing source without adding it again', async () => {
    const bridge = fake()
    render(<AddOwnServerDialog bridge={bridge} server={server} mode="choose" onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Two' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save choices' }))
    await waitFor(() => expect(bridge.chooseModels).toHaveBeenCalledWith(expect.objectContaining({ id: server.id, keptModelIds: ['one', 'two'] })))
    expect(bridge.add).not.toHaveBeenCalled()
  })
  it('uses the replacement operation and preserves the typed key on refusal', async () => {
    const bridge = fake({ replaceKey: vi.fn(async () => ({ status: 'refused' as const, reason: 'key-refused' as const, message: 'Refused' })) })
    render(<AddOwnServerDialog bridge={bridge} server={server} mode="replace" onClose={vi.fn()} />)
    const key = randomUUID()
    fireEvent.change(screen.getByLabelText('New key'), { target: { value: key } })
    fireEvent.click(screen.getByRole('button', { name: 'Check and replace' }))
    await screen.findByRole('alert')
    expect((screen.getByLabelText('New key') as HTMLInputElement).value).toBe(key)
    expect(bridge.add).not.toHaveBeenCalled()
  })
  it('closes Details before the dialog with Escape', async () => {
    await choose()
    const detail = screen.getAllByText('Details')[0]!.closest('details')!
    detail.open = true
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(detail.open).toBe(false)
  })
  it('keeps the block in Providers and offers replacement in More', async () => {
    render(<OwnModelServers bridge={fake()} />)
    await screen.findByText('Example')
    expect(screen.getByText('APIs and your own model servers')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'More for Example' }))
    expect(within(screen.getByRole('menu')).getByText('Replace key')).toBeTruthy()
  })
})
