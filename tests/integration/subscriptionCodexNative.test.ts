// @vitest-environment node
// SOTTO_NATIVE_CODEX_CONTRACT=1 npx vitest run tests/integration/subscriptionCodexNative.test.ts
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { CodexSubscriptionClient } from '../../src/main/agents/subscriptionCodex'

it.runIf(process.env.SOTTO_NATIVE_CODEX_CONTRACT === '1')('discovers the native account without hooks, MCP, inference or auth mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-codex-native-'))
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-codex-native-')) throw new Error('Unexpected native fixture directory')
  const home = join(root, 'fixture-native-home'), workingDirectory = join(root, 'discovery')
  const marker = join(root, 'unexpected-execution'), markerScript = join(root, 'marker.cjs')
  const apiLogin = JSON.stringify({ OPENAI_API_KEY: 'sk-sotto-invalid-contract-fixture' })
  try {
    await mkdir(home); await mkdir(workingDirectory)
    await writeFile(markerScript, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`)
    await writeFile(join(home, 'auth.json'), apiLogin)
    await writeFile(join(home, 'config.toml'), [
      `notify=[${JSON.stringify(process.execPath)}, ${JSON.stringify(markerScript)}]`,
      '[features]', 'hooks=true',
      '[mcp_servers.sotto_fixture]', `command=${JSON.stringify(process.execPath)}`, `args=[${JSON.stringify(markerScript)}]`,
    ].join('\n'))
    await writeFile(join(home, 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `"${process.execPath}" "${markerScript}"` }] }] } }))
    vi.stubEnv('CODEX_HOME', home)
    const status = await new CodexSubscriptionClient(workingDirectory).status()
    expect(status.ready).toBe(false)
    expect(status.detail).toContain('Sign in to Codex with ChatGPT')
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe(apiLogin)
    expect(await readdir(workingDirectory)).toEqual([])
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})
