import { quoteRemoteArgument, type ValidatedSshHostConfiguration } from './sshConfiguration'

/**
 * The launch script: fixed source the desktop runs with the SSH account's Node runtime to find or start the
 * host, ask it for a pairing code, revoke a client and stop a host it started. It lives as long as the SSH
 * session. User paths are a separately quoted JSON argument.
 */
export const LAUNCH_SCRIPT_SOURCE = String.raw`
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
const launcherPath = path.join(data, 'host-launcher.json');
const lockPath = path.join(data, 'host-listener.lock');
let child, pairing, stopping = false, ready = null, input = '';
// Replies carry a marker distinct from the one on requests, so a terminal echoing a request is never read as a reply.
const emit = event => process.stdout.write(cfg.replyMarker + JSON.stringify(event) + '\n');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const readLauncher = async () => {
  try { const value = JSON.parse(await fs.readFile(launcherPath, 'utf8')); return value && value.v === 1 && Number.isInteger(value.pid) ? value : null; }
  catch { return null; }
};
const writeLauncher = async pid => {
  await fs.mkdir(data, { recursive: true });
  const temporary = launcherPath + '.tmp';
  await fs.writeFile(temporary, JSON.stringify({ v: 1, pid, startedAt: new Date().toISOString() }));
  await fs.rename(temporary, launcherPath);
};
const removeLauncher = () => fs.rm(launcherPath, { force: true }).catch(() => undefined);
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
  const launcher = await readLauncher();
  return { ...live, owned: !!launcher && launcher.pid === live.pid };
};
const stopChild = async process => {
  if (!process || process.exitCode !== null || process.signalCode !== null) return;
  process.kill('SIGTERM');
  await Promise.race([new Promise(resolve => process.once('exit', resolve)), pause(15000)]);
  if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL');
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const lockHolder = async () => {
  try { const value = JSON.parse(await fs.readFile(lockPath, 'utf8')); return Number.isInteger(value.pid) && alive(value.pid) ? value.pid : null; }
  catch { return null; }
};
const stop = async () => {
  if (stopping) return; stopping = true;
  await stopChild(pairing);
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
    if (!line.startsWith(cfg.requestMarker)) continue;
    let command; try { command = JSON.parse(line.slice(cfg.requestMarker.length)); } catch { continue; }
    if (command.type === 'close') { void stop(); return; }
    if (command.type === 'stop-host' && typeof command.id === 'string') {
      const requestId = command.id;
      void (async () => {
        let stopped = false;
        if (ready && ready.owned) {
          const record = await readLauncher();
          const pid = record && record.pid === ready.pid ? record.pid : ready.pid;
          try { process.kill(pid, 'SIGTERM'); } catch {}
          const deadline = Date.now() + cfg.stopDrainMs;
          while (alive(pid) && Date.now() < deadline) await pause(100);
          if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} await pause(200); }
          stopped = !alive(pid);
          await removeLauncher();
        }
        emit({ type: 'host-stopped', id: requestId, stopped, hostId: ready ? ready.hostId : null });
        await stop();
      })();
      return;
    }
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
    if (existing) { ready = existing; emit({ type: 'ready', ...existing }); return; }
    // A live process holds the folder but is not listening yet: another client may have started it a moment ago. Wait for it rather than racing it.
    const holder = await lockHolder();
    if (holder !== null) {
      emit({ type: 'starting' });
      const deadline = Date.now() + cfg.readyTimeoutMs;
      while (!stopping && Date.now() < deadline && alive(holder)) {
        const current = await discover();
        if (current) { ready = current; emit({ type: 'ready', ...current }); return; }
        await pause(100);
      }
      if (stopping) return;
      if (alive(holder)) throw new Error('host-busy');
    }
    await removeLauncher();
    try { await fs.access(entry); } catch { throw new Error('archive-missing'); }
    emit({ type: 'starting' });
    child = spawn(process.execPath, [entry, '--data', data, '--port', String(cfg.remotePort)], { detached: true, stdio: 'ignore' });
    child.unref();
    let childFailed = false; child.on('error', () => { childFailed = true; });
    if (Number.isInteger(child.pid)) await writeLauncher(child.pid);
    const deadline = Date.now() + cfg.readyTimeoutMs;
    while (!stopping && Date.now() < deadline) {
      if (childFailed || child.exitCode !== null || child.signalCode !== null) throw new Error('host-start-failed');
      const current = await discover();
      if (current) {
        if (current.pid !== child.pid) { await stopChild(child); await removeLauncher(); child = undefined; }
        ready = { ...current, owned: !!child }; emit({ type: 'ready', ...ready }); return;
      }
      await pause(100);
    }
    if (!stopping) throw new Error('host-timeout');
  } catch (error) {
    if (!ready) { await stopChild(child); await removeLauncher(); }
    const allowed = ['archive-missing', 'descriptor-invalid', 'port-taken', 'host-busy', 'host-start-failed', 'host-timeout'];
    emit({ type: 'error', reason: allowed.includes(error.message) ? error.message : 'host-start-failed' });
    await stop();
  }
})();
`

/** Requests go out after `request` and replies come back after `reply`; the two never match each other. */
export interface LaunchScriptMarkers { readonly request: string; readonly reply: string }
/** How long Stop host lets a host finish its running turns after SIGTERM before the script kills it. */
export const HOST_STOP_DRAIN_MS = 15_000
/**
 * How long the desktop waits for the script to say the host stopped: the drain, the kill and the reply's
 * trip back over SSH. Shorter, and the desktop would report a failure while the stop was still going and
 * then close the session that was carrying it out.
 */
export const HOST_STOP_REPLY_MS = HOST_STOP_DRAIN_MS + 5_000
export function launchScriptCommand(configuration: ValidatedSshHostConfiguration, markers: LaunchScriptMarkers, readyTimeoutMs: number): string {
  return ['node', '--input-type=commonjs', '-e', LAUNCH_SCRIPT_SOURCE,
    JSON.stringify({ installPath: configuration.installPath, dataDirectory: configuration.dataDirectory, remotePort: configuration.remotePort, requestMarker: markers.request, replyMarker: markers.reply, readyTimeoutMs,
      stopDrainMs: HOST_STOP_DRAIN_MS })]
    .map(quoteRemoteArgument).join(' ')
}
