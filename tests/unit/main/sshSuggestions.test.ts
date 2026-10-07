// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverSshHosts, parseKnownHosts, parseSshConfig } from '../../../src/main/hosts/sshSuggestions'

describe('parseSshConfig', () => {
  it('reads every alias on a Host line, skips wildcards and negations, and keeps the first HostName and User', () => {
    const parsed = parseSshConfig([
      '# a comment',
      'Host forge forge-tail',
      '  HostName forge.tail5728ca.ts.net',
      '  User zach',
      '  HostName ignored.example',
      'Host *.internal !secret pi?',
      '  User nobody',
      'Host=pihole',
      '  Hostname = 100.77.163.67 # the Pi',
      '  User "pi"',
    ].join('\r\n'))
    expect(parsed.hosts).toEqual([
      { alias: 'forge', hostname: 'forge.tail5728ca.ts.net', user: 'zach' },
      { alias: 'forge-tail', hostname: 'forge.tail5728ca.ts.net', user: 'zach' },
      { alias: 'pihole', hostname: '100.77.163.67', user: 'pi' },
    ])
  })
  it('does not attribute the lines under a Match block to the Host before it', () => {
    const parsed = parseSshConfig('Host buildbox\nMatch host buildbox exec "true"\n  User other\n  HostName elsewhere\n')
    expect(parsed.hosts).toEqual([{ alias: 'buildbox' }])
  })
  it('collects Include patterns in order, wherever they appear', () => {
    expect(parseSshConfig('Include config.d/*\nHost a\n  Include ~/.ssh/extra "with space"\n').includes).toEqual(['config.d/*', '~/.ssh/extra', 'with space'])
  })
  it('expands %h in a HostName to the alias', () => {
    expect(parseSshConfig('Host lab\n  HostName %h.example.net\n').hosts).toEqual([{ alias: 'lab', hostname: 'lab.example.net' }])
  })
  it('keeps a jump, counts any ProxyCommand but none as one, and lets the first one win', () => {
    const parsed = parseSshConfig([
      'Host lan',
      '  HostName 192.168.1.10',
      '  ProxyJump bastion',
      'Host forwarded',
      '  ProxyCommand ssh -q -W %h:%p bastion',
      'Host quoted',
      '  ProxyCommand "ssh -J bastion %h"',
      'Host path',
      '  ProxyCommand /usr/bin/ssh -W %h:%p user@bastion',
      'Host proxied',
      '  ProxyCommand nc -X connect %h %p',
      'Host direct',
      '  ProxyCommand none',
      '  ProxyJump bastion',
      'Host off',
      '  ProxyJump none',
      '  ProxyJump bastion',
    ].join('\n'))
    expect(parsed.hosts).toEqual([
      { alias: 'lan', hostname: '192.168.1.10', jump: true },
      { alias: 'forwarded', jump: true },
      { alias: 'quoted', jump: true },
      { alias: 'path', jump: true },
      { alias: 'proxied', jump: true },
      { alias: 'direct' },
      { alias: 'off' },
    ])
  })
})

describe('parseKnownHosts', () => {
  it('reads plain names and bracketed ports, and skips hashed, marked and pattern lines', () => {
    expect(parseKnownHosts([
      'forge.tail5728ca.ts.net,100.64.0.2 ssh-ed25519 AAAAC3Nza',
      '[buildbox.example.net]:2222 ssh-ed25519 AAAAC3Nza',
      '|1|F1E1KeoE/eEWhi10WpGv4OdiO6Y=|3988QV0VE8wmZL7suNrYQLITLCg= ssh-rsa AAAAB3Nza',
      '@cert-authority *.example.net ssh-rsa AAAAB3Nza',
      '@revoked old.example.net ssh-rsa AAAAB3Nza',
      '*.wild ssh-rsa AAAAB3Nza',
      '# comment',
      '',
      'forge.tail5728ca.ts.net ecdsa-sha2-nistp256 AAAAE2Vj',
    ].join('\n'))).toEqual([
      { host: 'forge.tail5728ca.ts.net' },
      { host: '100.64.0.2' },
      { host: 'buildbox.example.net', port: 2222 },
    ])
  })
})

describe('discoverSshHosts', () => {
  let home: string | undefined
  afterEach(async () => { if (home) await rm(home, { recursive: true, force: true }); home = undefined })
  async function write(path: string, text: string): Promise<void> {
    await mkdir(dirname(join(home!, path)), { recursive: true })
    await writeFile(join(home!, path), text)
  }

  it('offers nothing, without failing, when there is no SSH folder', async () => {
    home = await mkdtemp(join(tmpdir(), 'sotto-ssh-suggestions-'))
    await expect(discoverSshHosts({ home })).resolves.toEqual([])
  })

  it('follows Include, offers aliases in the order written, then known hosts no alias already reaches', async () => {
    home = await mkdtemp(join(tmpdir(), 'sotto-ssh-suggestions-'))
    await write('.ssh/config', 'Include config.d/*.conf\nInclude ~/.ssh/missing\nHost forge\n  HostName forge.tail5728ca.ts.net\n  User zach\nHost *\n  ServerAliveInterval 30\n')
    await write('.ssh/config.d/10-lab.conf', 'Host pihole\n  HostName 100.77.163.67\n  User pi\nInclude ../config\n')
    await write('.ssh/config.d/20-work.conf', 'Host omarchy\n')
    await write('.ssh/config.d/notes.txt', 'Host not-included\n')
    await write('.ssh/known_hosts', [
      'forge.tail5728ca.ts.net ssh-ed25519 AAAA',
      'zeta.example.net ssh-ed25519 AAAA',
      '[alpha.example.net]:2200 ssh-ed25519 AAAA',
      '|1|abc=|def= ssh-ed25519 AAAA',
      'omarchy ssh-ed25519 AAAA',
    ].join('\n'))
    expect(await discoverSshHosts({ home })).toEqual([
      { alias: 'pihole', source: 'config', detail: 'pi@100.77.163.67', hostname: '100.77.163.67' },
      { alias: 'omarchy', source: 'config' },
      { alias: 'forge', source: 'config', detail: 'zach@forge.tail5728ca.ts.net', hostname: 'forge.tail5728ca.ts.net' },
      { alias: 'alpha.example.net', source: 'known-hosts', port: 2200, detail: 'alpha.example.net:2200' },
      { alias: 'zeta.example.net', source: 'known-hosts' },
    ])
  })

  it('follows an Include with a wildcard in a folder, as Colima and OrbStack write them', async () => {
    home = await mkdtemp(join(tmpdir(), 'sotto-ssh-suggestions-'))
    await write('.ssh/config', 'Include ~/.colima/*/ssh_config\nHost forge\n')
    await write('.colima/default/ssh_config', 'Host colima\n  HostName 127.0.0.1\n')
    await write('.colima/work/ssh_config', 'Host colima-work\n')
    await write('.colima/_lima/ssh_config.bak', 'Host not-included\n')
    expect((await discoverSshHosts({ home })).map(item => item.alias)).toEqual(['colima', 'colima-work', 'forge'])
  })

  it('remembers a jump on the alias, and not a direct connection to the same address', async () => {
    home = await mkdtemp(join(tmpdir(), 'sotto-ssh-suggestions-'))
    await write('.ssh/config', 'Host lan\n  HostName 192.168.1.10\n  User zach\n  ProxyJump bastion\nHost desk\n  HostName 192.168.1.10\n')
    expect(await discoverSshHosts({ home })).toEqual([
      { alias: 'lan', source: 'config', detail: 'zach@192.168.1.10', hostname: '192.168.1.10', jump: true },
      { alias: 'desk', source: 'config', detail: '192.168.1.10', hostname: '192.168.1.10' },
    ])
  })
})
