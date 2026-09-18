// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { claudeFixture } from '../fixtures/claudeFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'
import type { AdapterFixture } from './adapterContract'

it('Grok confirms requested effort from native load state when its change event has not arrived yet', async () => {
  const f = await grokFixture()
  try {
    await f.script({ modelNotificationAfterResponse: true })
    await f.host.connect(); await f.host.execute({ type: 'create-project', commandId: 'p', projectId: 'p', title: 'P', path: f.root })
    expect(await f.host.execute({ type: 'create-thread', commandId: 't', threadId: 't', projectId: 'p', title: 'T', modelId: f.modelId, reasoningEffort: 'high' })).toEqual({ accepted: true })
    expect((await f.host.snapshot()).threads[0]).toMatchObject({ modelId: f.modelId, reasoningEffort: 'high', status: 'idle' })
    expect((await f.driver.requests()).filter(request => request.method === 'session/prompt')).toHaveLength(0)
  } finally { await f.cleanup() }
})

for (const provider of ['claude', 'grok'] as const) it(`${provider} catalog/send uses the owning native scope, validates stale selections and never resends on reconnect`, async () => {
  let f: AdapterFixture = provider === 'claude' ? await claudeFixture() : await grokFixture()
  const id = randomUUID()
  try {
    const skillsPath = join(f.root, 'skills.json')
    const nativeCatalog = provider === 'claude' ? [{ name: 'check', description: 'Synthetic (project)' }] : { skills: [{ name: 'check', description: 'Synthetic', source: { path: join(f.root, 'SKILL.md'), type: 'project' }, userInvocable: true }] }
    await writeFile(skillsPath, JSON.stringify(nativeCatalog))
    await f.host.connect(); await f.host.execute({ type: 'create-project', commandId: 'p', projectId: 'p', title: 'P', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: 't', threadId: id, projectId: 'p', modelId: f.modelId, title: 'T' })
    const catalog = await f.host.listThreadSkills!(id)
    expect(catalog).toMatchObject({ providerId: provider, cwd: f.root, status: 'ready', maxSkillsPerMessage: 1 })
    const selected = { name: catalog.skills[0]!.name, path: catalog.skills[0]!.path }
    expect(await f.host.execute({ type: 'send', commandId: 'send', messageId: 'user', threadId: id, text: '$check verify', skills: [selected] })).toEqual({ accepted: true })
    await f.driver.completeTurn(id, 'Verified')
    await expect.poll(async () => (await f.host.snapshot()).threads[0]?.status).toBe('idle')
    const records = await f.driver.requests()
    const prompts = records.filter(r => r.method === (provider === 'claude' ? 'user' : 'session/prompt'))
    expect(JSON.stringify(prompts)).toContain('/check verify')
    expect(JSON.stringify(prompts)).not.toContain('$check')
    await writeFile(skillsPath, JSON.stringify(provider === 'claude' ? [] : { skills: [] }))
    await expect(f.host.execute({ type: 'send', commandId: 'stale', messageId: 'stale', threadId: id, text: '$check', skills: [selected] })).rejects.toThrow('available')
    f = await f.driver.restart(); await f.host.connect()
    expect((await f.host.listThreadSkills!(id)).skills).toEqual([])
    expect((await f.driver.requests()).filter(r => r.method === (provider === 'claude' ? 'user' : 'session/prompt'))).toHaveLength(1)
    await writeFile(skillsPath, JSON.stringify({ invalidNativeCatalog: true }))
    expect(await f.host.listThreadSkills!(id, true)).toMatchObject({ providerId: provider, status: 'error', skills: [] })
  } finally { await f.cleanup() }
})
