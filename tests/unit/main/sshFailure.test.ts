// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { HOST_SETUP_STEPS } from '../../../src/shared/hosts'
import { LAUNCH_REASONS, classifySshExit, failureFix, failureStep, type SshFailureCode } from '../../../src/main/hosts/sshFailure'
import { isTailscaleApprovalUrl, tailscaleHold } from '../../../src/main/hosts/tailscaleApproval'

describe('Tailscale SSH check banner', () => {
  // What Windows' OpenSSH printed on the laptop on September 27, at DEBUG1, with the token shortened.
  const windows = [
    'debug1: Connecting to forge.tail5728ca.ts.net [100.106.126.4] port 22.',
    'debug1: Connection established.',
    'debug1: Server host key: ssh-ed25519 SHA256:fixtureKey',
    '# Tailscale SSH requires an additional check.',
    '# To authenticate, visit: https://login.tailscale.com/a/l1a2b3c4d5e6',
    '',
  ].join('\r\n')
  it('reads the hold and the approval page among debug lines and CRLF', () => {
    expect(tailscaleHold(windows)).toEqual({ url: 'https://login.tailscale.com/a/l1a2b3c4d5e6' })
  })
  it('sees a hold before its URL line arrives', () => {
    expect(tailscaleHold('# Tailscale SSH requires an additional check.\n')).toEqual({})
  })
  it('finds nothing in ordinary SSH output', () => {
    expect(tailscaleHold('debug1: Connection established.\nuser@forge: Permission denied (publickey).\n')).toBeUndefined()
    // A server banner that only mentions a URL is not Tailscale asking.
    expect(tailscaleHold('# To authenticate, visit: https://login.tailscale.com/a/l1\n')).toBeUndefined()
  })
  it.each([
    ['https://login.tailscale.com.example.net/a/l1', 'another host that starts the same'],
    ['http://login.tailscale.com/a/l1', 'plain http'],
    ['https://evil.example/a/l1', 'another host'],
    ['https://user@login.tailscale.com/a/l1', 'a user in front'],
    ['https://login.tailscale.com:8443/a/l1', 'another port'],
    ['javascript:alert(1)', 'a script'],
  ])('keeps the hold but opens no page for %s (%s)', url => {
    expect(isTailscaleApprovalUrl(url)).toBe(false)
    expect(tailscaleHold(`# Tailscale SSH requires an additional check.\n# To authenticate, visit: ${url}\n`)).toEqual({})
  })
  it('accepts only Tailscale\'s own approval pages', () => {
    expect(isTailscaleApprovalUrl('https://login.tailscale.com/a/l1a2b3c4d5e6')).toBe(true)
    expect(isTailscaleApprovalUrl('https://login.tailscale.com/a/l1a2b3c4d5e6?x=1')).toBe(true)
  })
})

describe('classifySshExit', () => {
  const exit = (stderr: string, extra: { exitCode?: number | null; heldForApproval?: boolean } = {}) => classifySshExit({ exitCode: 255, stderr, ...extra }, 'host-start-failed').code
  it('reads OpenSSH\'s own read timeout while signing in as a timeout, not the catch-all', () => {
    expect(exit('Connection to 100.106.126.4 port 22 timed out\r\n')).toBe('connect-timeout')
    expect(exit('Connection to forge.tail5728ca.ts.net port 2222 timed out\n')).toBe('connect-timeout')
  })
  it('reads the end of a connection Tailscale held for approval as the approval not coming', () => {
    expect(exit('# Tailscale SSH requires an additional check.\nConnection to 100.106.126.4 port 22 timed out\n', { heldForApproval: true })).toBe('tailscale-unapproved')
    expect(exit('Connection closed by 100.106.126.4 port 22\n', { heldForApproval: true })).toBe('tailscale-unapproved')
  })
  it('says a hold on the live keepalive ended after 30 seconds, not 5 minutes', () => {
    const held = (liveWait?: 'forward' | 'request') => classifySshExit({ exitCode: 255, stderr: 'Connection to 100.106.126.4 port 22 timed out\n', heldForApproval: true, liveWait }, 'forward-failed').message
    expect(held()).toContain('no approval came within 5 minutes')
    expect(held('forward')).toBe('Tailscale SSH asked you to approve the port forward as well, and closed it after 30 seconds without an approval. Try again, and approve it in your browser when Sotto asks.')
    expect(held('request')).toContain('Sotto shows an approval only while it connects. Nothing was changed. Switch the host off and on')
  })
  it.each([
    ['ssh: connect to host forge port 22: Connection timed out', 'ssh-unreachable'],
    ['ssh: Could not resolve hostname forge: Name or service not known', 'ssh-unreachable'],
    ['zach@forge: Permission denied (publickey).', 'auth-failed'],
    ['@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@', 'host-key-changed'],
    ['Host key verification failed.', 'host-key-rejected'],
    ['something else entirely', 'ssh-failed'],
  ] as const)('keeps its reading of %s', (stderr, code) => {
    expect(exit(stderr)).toBe(code)
  })
  it('never reads debug lines, and keeps exit 127 as Node missing', () => {
    expect(exit('debug1: Connection to port 4317 forwarding to 127.0.0.1 timed out\n')).toBe('ssh-failed')
    expect(exit('', { exitCode: 127 })).toBe('node-missing')
  })
})

describe('the step each failure belongs to', () => {
  const expected: Partial<Record<SshFailureCode, string>> = {
    'ssh-unreachable': 'reach', 'tailscale-unapproved': 'tailscale', 'auth-failed': 'sign-in', 'host-key-changed': 'sign-in', 'host-key-rejected': 'sign-in',
    'prompt-unanswered': 'sign-in', 'identity-file-unreadable': 'sign-in', 'node-missing': 'install', 'node-too-old': 'install', 'node-too-new': 'install',
    'archive-missing': 'install', 'port-taken': 'start', 'host-busy': 'start', 'host-start-failed': 'start', 'host-timeout': 'start', 'descriptor-invalid': 'start',
    'forward-failed': 'start', 'forward-timeout': 'start', 'pairing-failed': 'pair',
  }
  it.each(Object.entries(expected))('%s shows on %s', (code, step) => {
    expect(failureStep(code as SshFailureCode)).toBe(step)
  })
  it('places every failure the host side reports, on a step of the checklist', () => {
    for (const code of LAUNCH_REASONS) expect(HOST_SETUP_STEPS).toContain(failureStep(code))
  })
  it('leaves a timeout or the catch-all on whichever step the connect reached', () => {
    for (const code of ['connect-timeout', 'ssh-failed', 'cancelled'] as const) expect(failureStep(code)).toBeUndefined()
  })
})

describe('failureFix', () => {
  const context = { target: 'zach@forge', installPath: '~/.local/share/sotto-host', hostname: 'forge.tail5728ca.ts.net', version: '0.1.21' }
  it('offers the ssh command that shows SSH\'s own words for a reach or sign-in failure', () => {
    expect(failureFix('ssh-failed', context)?.command).toBe('ssh zach@forge')
    expect(failureFix('auth-failed', { ...context, sshPort: 2222 })?.command).toBe('ssh -p 2222 zach@forge')
  })
  it('signs in with the identity file Sotto used, quoted where it has a space, and offers nothing for one a shell would misread', () => {
    expect(failureFix('auth-failed', { ...context, identityFile: '/home/zach/.ssh/forge_ed25519' })?.command).toBe('ssh -i /home/zach/.ssh/forge_ed25519 -o IdentitiesOnly=yes zach@forge')
    expect(failureFix('connect-timeout', { ...context, sshPort: 2222, identityFile: 'C:\\Users\\Zach Miller\\.ssh\\forge' })?.command)
      .toBe('ssh -i "C:\\Users\\Zach Miller\\.ssh\\forge" -o IdentitiesOnly=yes -p 2222 zach@forge')
    expect(failureFix('ssh-failed', { ...context, identityFile: '/home/zach/$(key)' })).toBeUndefined()
  })
  it('removes the stale known-hosts entry under the name SSH recorded it by', () => {
    expect(failureFix('host-key-changed', context)?.command).toBe('ssh-keygen -R forge.tail5728ca.ts.net')
    expect(failureFix('host-key-changed', { ...context, port: 2222 })?.command).toBe("ssh-keygen -R '[forge.tail5728ca.ts.net]:2222'")
  })
  it('unpacks this version\'s host archive into the installation folder', () => {
    expect(failureFix('archive-missing', context)).toEqual({
      text: 'Download Sotto-host-0.1.21-linux-x64.tar.gz from the Sotto releases page to the SSH host, then unpack it into the host installation folder there:',
      command: 'mkdir -p "$HOME/.local/share/sotto-host" && tar -xzf Sotto-host-0.1.21-linux-x64.tar.gz -C "$HOME/.local/share/sotto-host"',
    })
  })
  it('reads the journal of the boot unit on the host when the unit would not start the host or keep it running', () => {
    for (const code of ['boot-start-refused', 'boot-unit-failed'] as const) {
      expect(failureFix(code, context)).toEqual({ text: 'To see why, run this on the SSH host:', command: 'journalctl --user -u sotto-host -n 50 --no-pager' })
    }
  })
  it('offers no command it cannot write safely, and none for a failure without one exact fix', () => {
    expect(failureFix('archive-missing', { ...context, installPath: '/opt/sotto $(host)' })).toBeUndefined()
    expect(failureFix('host-key-changed', { ...context, hostname: 'forge;rm -rf ~' })).toBeUndefined()
    expect(failureFix('node-too-new', context)).toBeUndefined()
    expect(failureFix('tailscale-unapproved', context)).toBeUndefined()
  })
})
