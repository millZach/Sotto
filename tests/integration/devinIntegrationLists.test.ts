// @vitest-environment node
import { readFile, writeFile } from 'node:fs/promises'

import { join } from 'node:path'
import { expect, it } from 'vitest'
import { assertDevinNoIntegrations } from '../../src/main/agents/devinPolicy'
import { setup } from '../fixtures/devinPolicyFixture'

it('bounds native integration checks and keeps subprocess output out of failures', async () => {
  const { root } = await setup()
  const script = join(root, 'native-list.cjs')
  const profile = join(root, 'profile.json')
  await writeFile(profile, '{}')
  await writeFile(script, "console.log(process.argv.includes('plugins') ? 'No plugins installed.' : \"No MCP servers configured. Use 'devin mcp add' to add servers.\")")
  await expect(assertDevinNoIntegrations(process.execPath, [script, '--config', profile], {}, root)).resolves.toBeUndefined()
  await expect(assertDevinNoIntegrations(process.execPath, [script], {}, root)).rejects.toThrow(/require the Sotto/u)
  await writeFile(script, "console.error('PRIVATE_PROVIDER_OUTPUT'); process.exit(1)")
  await expect(assertDevinNoIntegrations(process.execPath, [script, '--config', profile], {}, root)).rejects.toThrow('Sotto could not check Devin integrations. Your thread is kept. Check the supported Devin installation and reconnect.')
})

it('runs both integration lists side by side and names the plugin refusal first however they finish', async () => {
  const { root } = await setup()
  const script = join(root, 'native-list.cjs')
  const profile = join(root, 'profile.json')
  const log = join(root, 'runs.log')
  await writeFile(profile, '{}')
  // Each run marks that it started, then answers only once the other has started too, so two lists run one after the
  // other never meet: the first gives up waiting, well inside the lists' own deadline, and says it ran alone. Both
  // refuse and the plugin list answers last, so the refusal named is the one judged first, not the one that finished first.
  await writeFile(script, `const { appendFileSync, existsSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const kind = process.argv.includes('plugins') ? 'plugins' : 'mcp'
const other = kind === 'plugins' ? 'mcp' : 'plugins'
writeFileSync(join(${JSON.stringify(root)}, 'started-' + kind), '')
const answer = () => console.log(kind === 'plugins' ? 'Installed plugins: one' : 'Configured MCP servers:\\n\\n  \\u2022 enabled\\n    Command: synthetic')
const began = Date.now()
const wait = setInterval(() => {
  const met = existsSync(join(${JSON.stringify(root)}, 'started-' + other))
  if (!met && Date.now() - began < 10000) return
  clearInterval(wait)
  appendFileSync(${JSON.stringify(log)}, (met ? 'met ' : 'alone ') + kind + '\\n')
  setTimeout(answer, kind === 'plugins' ? 50 : 0)
}, 5)`)
  await expect(assertDevinNoIntegrations(process.execPath, [script, '--config', profile], {}, root)).rejects.toThrow(/plugins/u)
  expect((await readFile(log, 'utf8')).trim().split('\n').sort()).toEqual(['met mcp', 'met plugins'])
})
