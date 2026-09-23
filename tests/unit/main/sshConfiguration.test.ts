// @vitest-environment node
import { expect, it } from 'vitest'
import { quoteRemoteArgument, validateSshHost } from '../../../src/main/hosts/sshConfiguration'
import { HOST_STOP_DRAIN_MS, HOST_STOP_REPLY_MS, launchScriptCommand } from '../../../src/main/hosts/launchScript'
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
  const command = launchScriptCommand(validated, { request: 'SOTTO_REQ_test:', reply: 'SOTTO_REP_test:' }, 30000)
  expect(command).toContain("it'\\''s $(literal)")
  expect(command).toContain("'node' '--input-type=commonjs' '-e'")
})
it('waits for a stop longer than the launch script lets the host drain', () => {
  const command = launchScriptCommand(validateSshHost(config), { request: 'SOTTO_REQ_test:', reply: 'SOTTO_REP_test:' }, 30000)
  expect(command).toContain('"stopDrainMs":' + HOST_STOP_DRAIN_MS)
  expect(HOST_STOP_REPLY_MS).toBeGreaterThan(HOST_STOP_DRAIN_MS)
})
it('rejects malformed ports and relative/control-character paths before spawning', () => {
  for (const remotePort of [-1, 65536, 1.5]) expect(() => validateSshHost({ ...config, remotePort })).toThrow('port')
  for (const installPath of ['', 'relative', '/path\nnext']) expect(() => validateSshHost({ ...config, installPath })).toThrow('path')
  expect(() => validateSshHost({ ...config, identityFile: '-oBad' })).toThrow('identity file')
})
