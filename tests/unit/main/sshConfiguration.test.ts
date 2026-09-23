// @vitest-environment node
import { expect, it } from 'vitest'
import { parseSshResolution, quoteRemoteArgument, validateSshHost } from '../../../src/main/hosts/sshConfiguration'
import { HOST_NODE_RANGE, HOST_STOP_DRAIN_MS, HOST_STOP_REPLY_MS, LAUNCH_SCRIPT_SOURCE, launchScriptCommand } from '../../../src/main/hosts/launchScript'
const config = { target: 'user@forge', installPath: '/opt/sotto' }
it.each(['forge', 'user@forge', 'user-name@forge.tailnet.ts.net', '127.0.0.1', 'user@[::1]'])('accepts an SSH host spec: %s', target => {
  expect(validateSshHost({ ...config, target })).toMatchObject({ target, dataDirectory: '~/.sotto', remotePort: 0 })
})
it.each(['-oProxyCommand=evil', 'forge;touch /tmp/x', 'user@forge bad', 'user@forge\ncommand', 'ssh://forge', 'user@forge:22', 'a@b@c', '@forge'])('refuses option/shell/URI target input: %s', target => {
  expect(() => validateSshHost({ ...config, target })).toThrow('SSH host')
})
it('quotes remote paths as data including single quotes and shell metacharacters', () => {
  expect(quoteRemoteArgument("it's $(literal); here")).toBe("'it'\\''s $(literal); here'")
  const validated = validateSshHost({ ...config, installPath: "/opt/it's $(literal)" })
  const command = launchScriptCommand(validated, { op: 'launch' }, 30000)
  expect(command).toContain("it'\\''s $(literal)")
  expect(command.startsWith("'sh' '-c' 'cfg=$1")).toBe(true)
  expect(command).toContain("'sotto-launch' '{\"op\":\"launch\"")
})
it('sends the launch script on stdin only and names the Node range the host archive needs', () => {
  const command = launchScriptCommand(validateSshHost(config), { op: 'stop-host', hostId: '11111111-1111-4111-8111-111111111111' }, 30000)
  expect(command).not.toContain(LAUNCH_SCRIPT_SOURCE.slice(0, 40))
  expect(command).toContain('"nodeRange":"' + HOST_NODE_RANGE + '"')
  expect(HOST_NODE_RANGE).toBe('>=24 <25')
})
it('waits for a stop longer than the launch script lets the host drain', () => {
  const command = launchScriptCommand(validateSshHost(config), { op: 'stop-host', hostId: '11111111-1111-4111-8111-111111111111' }, 30000)
  expect(command).toContain('"stopDrainMs":' + HOST_STOP_DRAIN_MS)
  expect(HOST_STOP_REPLY_MS).toBeGreaterThan(HOST_STOP_DRAIN_MS)
})
it('reads where ssh -G says a target goes, keeping the first value and every identity file', () => {
  expect(parseSshResolution('forge', 'host forge\nhostname 100.64.0.7\nuser zach\nport 2222\nport 22\nidentityfile ~/.ssh/forge\nidentityfile ~/.ssh/id_ed25519\n'))
    .toEqual({ hostname: '100.64.0.7', user: 'zach', port: 2222, identityFiles: ['~/.ssh/forge', '~/.ssh/id_ed25519'] })
  expect(parseSshResolution('user@forge', '')).toEqual({ hostname: 'forge', identityFiles: [] })
})
it('rejects malformed ports and relative/control-character paths before spawning', () => {
  for (const remotePort of [-1, 65536, 1.5]) expect(() => validateSshHost({ ...config, remotePort })).toThrow('port')
  for (const installPath of ['', 'relative', '/path\nnext']) expect(() => validateSshHost({ ...config, installPath })).toThrow('path')
  expect(() => validateSshHost({ ...config, identityFile: '-oBad' })).toThrow('identity file')
})
