import { quoteRemoteArgument, type ValidatedSshHostConfiguration } from './sshConfiguration'

/** Fixed source sent to the SSH account's Node runtime. User paths are a separately quoted JSON argument. */
export const SSH_SUPERVISOR_SOURCE = String.raw`
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const cfg = JSON.parse(process.argv[1]);
const resolvePath = value => path.resolve(value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value);
const data = resolvePath(cfg.dataDirectory);
const entry = path.join(resolvePath(cfg.installPath), 'host', 'index.js');
const descriptorPath = path.join(data, 'host-listener.json');
let child, pairing, stopping = false, ready = null, input = '';
const emit = event => process.stdout.write(cfg.marker + JSON.stringify(event) + '\n');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const health = port => new Promise((resolve, reject) => {
  const request = http.get({ hostname: '127.0.0.1', port, path: '/v1/health', timeout: 1500 }, response => {
    let body = ''; response.on('data', chunk => { body += chunk; if (body.length > 4096) request.destroy(new Error('invalid')); });
    response.on('end', () => { try { const value = JSON.parse(body); if (response.statusCode !== 200 || value.v !== 1 || value.status !== 'ready' || typeof value.hostId !== 'string' || !Number.isInteger(value.pid) || value.port !== port) throw new Error('invalid'); resolve(value); } catch { reject(new Error('occupied')); } });
  });
  request.on('timeout', () => request.destroy(new Error('timeout'))); request.on('error', reject);
});
const discover = async () => {
  let descriptor;
  try { descriptor = JSON.parse(await fs.readFile(descriptorPath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('descriptor-invalid'); }
  if (descriptor.v !== 1 || !Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 || typeof descriptor.hostId !== 'string' || !Number.isInteger(descriptor.pid)) throw new Error('descriptor-invalid');
  let live;
  try { live = await health(descriptor.port); }
  catch (error) { if (error.code === 'ECONNREFUSED') return null; throw new Error('port-taken'); }
  if (live.hostId !== descriptor.hostId || live.pid !== descriptor.pid) throw new Error('port-taken');
  return live;
};
const stopChild = async process => {
  if (!process || process.exitCode !== null || process.signalCode !== null) return;
  process.kill('SIGTERM');
  await Promise.race([new Promise(resolve => process.once('exit', resolve)), pause(15000)]);
  if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL');
};
const stop = async () => {
  if (stopping) return; stopping = true;
  await Promise.all([stopChild(pairing), stopChild(child)]);
  process.exit(0);
};
process.on('SIGTERM', stop); process.on('SIGINT', stop); process.on('SIGHUP', stop);
process.stdin.on('end', stop); process.stdin.on('close', stop); process.stdout.on('error', stop);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (input.length > 8192) { void stop(); return; }
  let newline;
  while ((newline = input.indexOf('\n')) !== -1) {
    const line = input.slice(0, newline).trim(); input = input.slice(newline + 1);
    if (!line.startsWith(cfg.marker)) continue;
    let command; try { command = JSON.parse(line.slice(cfg.marker.length)); } catch { continue; }
    if (command.type === 'close') { void stop(); return; }
    if (['pairing-code', 'revoke-client'].includes(command.type) && ready && !pairing && typeof command.id === 'string') {
      const requestId = command.id;
      const revoking = command.type === 'revoke-client';
      if (revoking && (typeof command.clientId !== 'string' || !command.clientId || command.clientId.length > 512)) continue;
      pairing = spawn(process.execPath, [entry, '--data', data, ...(revoking ? ['--revoke-client', command.clientId] : ['--pairing-code'])], { stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';
      const timer = setTimeout(() => { if (pairing) pairing.kill('SIGTERM'); }, 10000);
      pairing.stdout.on('data', chunk => { output += chunk; if (output.length > 4096 && pairing) pairing.kill('SIGTERM'); });
      pairing.on('error', () => {});
      pairing.once('close', code => {
        clearTimeout(timer); pairing = undefined;
        try {
          if (code !== 0 || output.length > 4096) throw new Error('pairing-failed');
          const value = JSON.parse(output.trim());
          if (value.v !== 1 || value.hostId !== ready.hostId) throw new Error('pairing-failed');
          if (revoking) {
            if (typeof value.revoked !== 'boolean') throw new Error('pairing-failed');
            emit({ type: 'revoked', id: requestId, revoked: value.revoked, hostId: value.hostId });
          } else {
            if (typeof value.code !== 'string' || typeof value.expiresAt !== 'string') throw new Error('pairing-failed');
            emit({ type: 'pairing-code', id: requestId, code: value.code, expiresAt: value.expiresAt, hostId: value.hostId });
          }
        } catch { emit({ type: 'pairing-failed', id: requestId }); }
      });
    }
  }
});
(async () => {
  try {
    const existing = await discover();
    if (stopping) return;
    if (existing) { ready = existing; emit({ type: 'ready', ...existing, owned: false }); return; }
    try { await fs.access(entry); } catch { throw new Error('archive-missing'); }
    emit({ type: 'starting' });
    child = spawn(process.execPath, [entry, '--data', data, '--port', String(cfg.remotePort)], { stdio: 'ignore' });
    let childFailed = false; child.on('error', () => { childFailed = true; });
    const deadline = Date.now() + cfg.readyTimeoutMs;
    while (!stopping && Date.now() < deadline) {
      if (childFailed || child.exitCode !== null || child.signalCode !== null) throw new Error('host-start-failed');
      const current = await discover();
      if (current) {
        if (current.pid !== child.pid) { await stopChild(child); child = undefined; }
        ready = current; emit({ type: 'ready', ...current, owned: !!child }); return;
      }
      await pause(100);
    }
    if (!stopping) throw new Error('host-timeout');
  } catch (error) {
    const allowed = ['archive-missing', 'descriptor-invalid', 'port-taken', 'host-start-failed', 'host-timeout'];
    emit({ type: 'error', reason: allowed.includes(error.message) ? error.message : 'host-start-failed' });
    await stop();
  }
})();
`

export function sshSupervisorCommand(configuration: ValidatedSshHostConfiguration, marker: string, readyTimeoutMs: number): string {
  return ['node', '--input-type=commonjs', '-e', SSH_SUPERVISOR_SOURCE,
    JSON.stringify({ installPath: configuration.installPath, dataDirectory: configuration.dataDirectory, remotePort: configuration.remotePort, marker, readyTimeoutMs })]
    .map(quoteRemoteArgument).join(' ')
}
