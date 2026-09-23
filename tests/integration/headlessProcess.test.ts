// @vitest-environment node
import { spawn } from 'node:child_process'
import { isBuiltin } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'vite'
import ts from 'typescript'

let root: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'sotto-headless-process-'))
  await build({ configFile: false, logLevel: 'silent', ssr: { noExternal: ['zod'] }, build: {
    ssr: resolve('src/host/index.ts'), target: 'node24', outDir: root, emptyOutDir: false, minify: false,
    rollupOptions: { external: id => isBuiltin(id), output: { format: 'cjs', entryFileNames: 'host.cjs' } },
  } })
})
afterAll(async () => {
  if (root && dirname(root) === tmpdir() && root.includes('sotto-headless-process-')) await rm(root, { recursive: true, force: true })
})

describe('the built Node host process', () => {
  it('contains no Electron import anywhere in its source dependency graph', async () => {
    const seen = new Set<string>()
    const inspect = async (file: string): Promise<void> => {
      if (seen.has(file)) return
      seen.add(file)
      const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true)
      const imports: string[] = []
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text)
        if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text)
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
          const argument = node.arguments[0]
          if (argument && ts.isStringLiteral(argument)) imports.push(argument.text)
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
      for (const specifier of imports) {
        expect(specifier, file).not.toMatch(/^electron(?:$|\/)/u)
        if (specifier.startsWith('.') && !specifier.endsWith('.json')) await inspect(resolve(dirname(file), specifier + (extname(specifier) ? '' : '.ts')))
      }
    }
    await inspect(resolve('src/host/index.ts'))
    expect(seen.size).toBeGreaterThan(50)
    const bundle = await readFile(join(root, 'host.cjs'), 'utf8')
    expect(bundle).not.toMatch(/require\(["']electron["']\)/u)
  })

  it('starts under Node, handles SIGTERM and exits cleanly with its data intact', async () => {
    // No provider is enabled in this fixture. Native adapter process journeys are in headlessHost.
    const data = join(root, 'data')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(data)
    const { defaultAgentConfiguration } = await import('../../src/shared/agents')
    await writeFile(join(data, 'agents.json'), JSON.stringify({
      configuration: { ...defaultAgentConfiguration(), enabled: false, enabledProviders: [] },
      assignments: [], queue: [], activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null,
      composing: false, outbox: [],
    }))
    const child = spawn(process.execPath, ['--import', pathToFileURL(resolve('tests/fixtures/headlessSignal.mjs')).href, join(root, 'host.cjs'), '--data', data], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    let output = ''
    child.stdout!.on('data', chunk => { output += String(chunk) })
    child.stderr!.on('data', chunk => { output += String(chunk) })
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolveExit, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolveExit({ code, signal }))
    })
    try {
      await expect.poll(() => output).toContain('[Sotto] host-ready')
      if (process.platform === 'win32') child.send('SIGTERM')
      else child.kill('SIGTERM')
      expect(await exited).toEqual({ code: 0, signal: null })
      expect(JSON.parse(await readFile(join(data, 'host.json'), 'utf8')).hostId).toEqual(expect.any(String))
      expect(JSON.parse(await readFile(join(data, 'workspace.json'), 'utf8')).snapshot.threads).toEqual([])
      expect(output).not.toContain('failed')
    } finally { if (child.exitCode === null) child.kill() }
  })

  it('fails a bad invocation without leaking paths or credentials into diagnostics', async () => {
    const child = spawn(process.execPath, [join(root, 'host.cjs'), '--unknown', 'synthetic-private-value'], { windowsHide: true, stdio: 'pipe' })
    let output = ''
    child.stderr!.on('data', chunk => { output += String(chunk) })
    const code = await new Promise<number | null>((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit) })
    expect(code).toBe(1)
    expect(output).toContain('host-start-failed')
    expect(output).not.toContain('synthetic-private-value')
  })
})
