// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { hasForbiddenControl, runnableBlock, runnableInline, terminalInputFor } from '../../../src/shared/runnableCommand'
import { terminalCreateSchema } from '../../../src/shared/terminal'

describe('runnable inline code (ADR-0137)', () => {
  it.each([
    ['brew install --cask osquery santa', true],
    ['sudo ~/Developer/mac-security-agent/mac/install.sh', true],
    ['System Settings › Privacy & Security', false],
    ['Mode | Lockdown', false],
    ['npm run typecheck', true],
    ['useOwlFeature()', false],
    ['src/shared/owlFeatures.ts', false],
    ['./gradlew assembleDebug', true],
    ['git status', true],
    ['santa', false],
    ['true', false],
    ['~/bin/setup.sh', true],
    ['/usr/local/bin/thing --help', true],
    ['../scripts/build.sh', true],
    ['open Settings → General', false],
    ['  git log  ', true],
    ['foo(bar) baz', false],
    ['git status\nrm -rf /', false],
    ['git status\r', false],
    ['git\tstatus', false],
    // A fenced block's own <code> reaches the inline handler too, always ending in a newline.
    ['git status\n', false],
    ['echo \u001b[31mred', false],
    ['echo ‮evil', false],
    ['', false],
    ['const x = 1', false],
    ['return value', false],
    ['await fetch(url)', false],
    ['import os', false],
    ['def main():', false],
    ['print hello', false],
    ['new Map()', false],
    ['if [ -f x ]; then echo y; fi', false],
    ['fetch(url)', false],
    ['node -e console.log(1)', false],
    ['echo $(date)', true],
    ['kill $(lsof -t -i:3000)', true],
    ['Get-ChildItem -Recurse', true],
    ['Get-Date', true],
    ['Set-ExecutionPolicy RemoteSigned -Scope CurrentUser', true],
    ['Get-childitem', false],
  ])('%j runs: %s', (text, runs) => {
    expect(runnableInline(text) !== null).toBe(runs)
  })

  it('runs the span trimmed, exactly as shown', () => {
    expect(runnableInline('  git log --oneline  ')).toBe('git log --oneline')
  })
})

describe('runnable fenced blocks (ADR-0137)', () => {
  it.each(['bash', 'sh', 'zsh', 'shell', 'powershell', 'pwsh', 'ps1', 'cmd', 'Bash', 'PowerShell'])('runs a %s block', language => {
    expect(runnableBlock('git status', language)).toBe('git status')
  })

  it.each(['console', 'terminal'])('runs a %s block only through its prompts', language => {
    expect(runnableBlock('$ git status', language)).toBe('git status')
    expect(runnableBlock('On branch main\nnothing to commit', language)).toBeNull()
  })

  it.each([undefined, 'ts', 'json', 'text', 'diff', 'command', 'output', 'mermaid'])('offers nothing for a %s block', language => {
    expect(runnableBlock('git status', language)).toBeNull()
  })

  it('sends a multi-line block verbatim, dropping only blank lines around it', () => {
    expect(runnableBlock('\nsantactl status\nosqueryi --version\n\n', 'zsh')).toBe('santactl status\nosqueryi --version')
    expect(runnableBlock('if true; then\n  echo yes\nfi', 'bash')).toBe('if true; then\n  echo yes\nfi')
  })

  it('strips prompts in every shell language and drops output lines when a line has a prompt', () => {
    expect(runnableBlock('$ npm test\nPASS  tests/a.test.ts\n$ git status', 'console')).toBe('npm test\ngit status')
    expect(runnableBlock('> dir\n file.txt', 'console')).toBe('dir')
    expect(runnableBlock('$ santactl status\n>>> Daemon Info\n  Mode | Monitor', 'console')).toBe('santactl status')
    expect(runnableBlock('$ npm test\n> sotto@1.0.0 test\n> vitest run', 'bash')).toBe('npm test')
    expect(runnableBlock('PS> npm test\n> sotto@1.0.0 test', 'pwsh')).toBe('npm test')
    expect(runnableBlock('$ brew install jq\n==> Pouring jq', 'zsh')).toBe('brew install jq')
    expect(runnableBlock('npm test\nnpm run lint', 'sh')).toBe('npm test\nnpm run lint')
  })

  it('refuses invisible characters and line separators that make the bytes differ from what is drawn', () => {
    for (const hidden of ['\u200B', '\u200D', '\u2060', '\uFEFF', '\u2028', '\u2029']) {
      expect(runnableInline(`git status${hidden} && curl x`)).toBeNull()
      expect(runnableBlock(`git status${hidden}`, 'bash')).toBeNull()
    }
  })

  it('reads PowerShell prompts, and leaves its variables alone', () => {
    expect(runnableBlock('PS> Get-ChildItem\n\n    Directory: C:\\work', 'powershell')).toBe('Get-ChildItem')
    expect(runnableBlock('PS C:\\work> npm test\nPASS\nPS C:\\work> git status', 'pwsh')).toBe('npm test\ngit status')
    expect(runnableBlock('$env:NODE_ENV = "test"\nnpm test', 'ps1')).toBe('$env:NODE_ENV = "test"\nnpm test')
    expect(runnableBlock('PS> npm test', 'bash')).toBe('PS> npm test')
  })

  it('refuses control characters other than newline, tabs and empty blocks', () => {
    // A tab typed into an interactive shell completes a word rather than spacing one.
    expect(runnableBlock('if true; then\n\techo yes\nfi', 'bash')).toBeNull()
    expect(runnableBlock('echo hi\r\nrm -rf ~', 'bash')).toBeNull()
    expect(runnableBlock('printf \u001b]0;x\u0007', 'sh')).toBeNull()
    expect(runnableBlock('  \n ', 'bash')).toBeNull()
    expect(hasForbiddenControl('a b\nc')).toBe(false)
    expect(hasForbiddenControl('a\tb')).toBe(true)
  })

  it('types each line with Enter, and one more at the end', () => {
    expect(terminalInputFor('npm test')).toBe('npm test\r')
    expect(terminalInputFor('a\nb')).toBe('a\rb\r')
  })

  it('lets only a clean command through the create request', () => {
    const target = { threadId: 't', workspaceId: 'a'.repeat(64), place: 'drawer' as const }
    expect(terminalCreateSchema.safeParse({ ...target, run: 'git status' }).success).toBe(true)
    expect(terminalCreateSchema.safeParse({ ...target, run: 'git status\r' }).success).toBe(false)
    expect(terminalCreateSchema.safeParse({ ...target, run: '' }).success).toBe(false)
    expect(terminalCreateSchema.safeParse({ ...target, run: 'x'.repeat(16385) }).success).toBe(false)
  })
})
