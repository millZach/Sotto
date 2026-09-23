import { HOST_NODE_MAJOR } from './sshFailure'
import { quoteRemoteArgument, type ValidatedSshHostConfiguration } from './sshConfiguration'

/**
 * The launch script: fixed Node source the desktop pipes to one `ssh` command per operation. It finds or
 * starts the host, asks it for a pairing code, revokes a client, or stops a host Sotto started, writes
 * one JSON result line to stdout and exits. The source travels on stdin, so it is never in the remote
 * process list; the configuration, which holds no secret, is a separately quoted JSON argument.
 *
 * A host the script starts is told so through SOTTO_HOST_STARTED_BY, and records it in its own
 * listener descriptor once it holds the data folder's lock. That descriptor is what makes a host
 * "started by Sotto": only the host holding the lock writes it, so two launches racing cannot take
 * the mark from each other, and it stays true across every later reconnect.
 */
export const LAUNCH_SCRIPT_SOURCE = String.raw`'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const cfg = JSON.parse(process.argv[process.argv[1] === '-' ? 2 : 1]);
const resolvePath = value => path.resolve(value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value);
const data = resolvePath(cfg.dataDirectory);
const entry = path.join(resolvePath(cfg.installPath), 'host', 'index.js');
const descriptorPath = path.join(data, 'host-listener.json');
// Written by launch scripts before a host recorded its own start. Read so a host started that way stays stoppable; never written.
const legacyLauncherPath = path.join(data, 'host-launcher.json');
const lockPath = path.join(data, 'host-listener.lock');
process.stdout.on('error', () => process.exit(0));
const say = event => new Promise(resolve => process.stdout.write(JSON.stringify(event) + '\n', () => resolve()));
const finish = async event => { await say(event); process.exit(0); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// The host's own rule: a process another account owns (EPERM) is still running.
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return !!error && error.code === 'EPERM'; } };
const readLegacyLauncher = async () => {
  try { const value = JSON.parse(await fs.readFile(legacyLauncherPath, 'utf8')); return value && value.v === 1 && Number.isInteger(value.pid) ? value : null; }
  catch { return null; }
};
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
  const legacy = await readLegacyLauncher();
  const owned = descriptor.startedBy === 'launch-script' || (!!legacy && legacy.pid === live.pid);
  return { v: 1, status: 'ready', hostId: live.hostId, pid: live.pid, port: live.port, owned };
};
const lockHolder = async () => {
  try { const value = JSON.parse(await fs.readFile(lockPath, 'utf8')); return Number.isInteger(value.pid) && alive(value.pid) ? value.pid : null; }
  catch { return null; }
};
const launch = async () => {
  const existing = await discover();
  if (existing) return finish({ type: 'ready', ...existing });
  // A live process holds the folder but is not listening yet: another client may have started it a moment ago. Wait for it rather than racing it.
  const holder = await lockHolder();
  if (holder !== null) {
    await say({ type: 'starting' });
    const deadline = Date.now() + cfg.readyTimeoutMs;
    while (Date.now() < deadline && alive(holder)) {
      const current = await discover();
      if (current) return finish({ type: 'ready', ...current });
      await pause(100);
    }
    if (alive(holder)) throw new Error('host-busy');
  }
  try { await fs.access(entry); } catch { throw new Error('archive-missing'); }
  await say({ type: 'starting' });
  const child = spawn(process.execPath, [entry, '--data', data, '--port', String(cfg.remotePort)], { detached: true, stdio: 'ignore', env: { ...process.env, SOTTO_HOST_STARTED_BY: 'launch-script' } });
  child.unref();
  let childFailed = false; child.on('error', () => { childFailed = true; });
  const deadline = Date.now() + cfg.readyTimeoutMs;
  while (Date.now() < deadline) {
    const current = await discover();
    if (current) return finish({ type: 'ready', ...current });
    // A child that lost the lock to a host another launch started a moment earlier exits at once; that host is waited for instead.
    if ((childFailed || child.exitCode !== null || child.signalCode !== null) && (await lockHolder()) === null) throw new Error('host-start-failed');
    await pause(100);
  }
  if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGTERM'); } catch {} }
  throw new Error('host-timeout');
};
const admin = async () => {
  const current = await discover().catch(() => null);
  if (!current || current.hostId !== cfg.hostId) return finish({ type: 'failed' });
  const revoking = cfg.op === 'revoke-client';
  if (revoking && (typeof cfg.clientId !== 'string' || !cfg.clientId || cfg.clientId.length > 512)) return finish({ type: 'failed' });
  const child = spawn(process.execPath, [entry, '--data', data, ...(revoking ? ['--revoke-client', cfg.clientId] : ['--pairing-code'])], { stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  const timer = setTimeout(() => child.kill('SIGTERM'), 10000);
  child.stdout.on('data', chunk => { output += chunk; if (output.length > 4096) child.kill('SIGTERM'); });
  child.on('error', () => {});
  const code = await new Promise(resolve => child.once('close', resolve));
  clearTimeout(timer);
  try {
    if (code !== 0 || output.length > 4096) throw new Error('failed');
    const value = JSON.parse(output.trim());
    if (value.v !== 1 || value.hostId !== current.hostId) throw new Error('failed');
    if (revoking) {
      if (typeof value.revoked !== 'boolean') throw new Error('failed');
      return finish({ type: 'revoked', revoked: value.revoked, hostId: value.hostId });
    }
    if (typeof value.code !== 'string' || typeof value.expiresAt !== 'string') throw new Error('failed');
    return finish({ type: 'pairing-code', code: value.code, expiresAt: value.expiresAt, hostId: value.hostId });
  } catch { return finish({ type: 'failed' }); }
};
const stopHost = async () => {
  const current = await discover().catch(() => null);
  if (!current) return finish({ type: 'host-stopped', stopped: true, hostId: null });
  if (current.hostId !== cfg.hostId || !current.owned) return finish({ type: 'host-stopped', stopped: false, hostId: current.hostId });
  const pid = current.pid;
  try { process.kill(pid, 'SIGTERM'); } catch {}
  const deadline = Date.now() + cfg.stopDrainMs;
  while (alive(pid) && Date.now() < deadline) await pause(100);
  if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} await pause(200); }
  const stopped = !alive(pid);
  const legacy = await readLegacyLauncher();
  if (stopped && legacy && legacy.pid === pid) await fs.rm(legacyLauncherPath, { force: true }).catch(() => undefined);
  return finish({ type: 'host-stopped', stopped, hostId: current.hostId });
};
(async () => {
  try {
    if (cfg.op === 'launch') await launch();
    else if (cfg.op === 'pairing-code' || cfg.op === 'revoke-client') await admin();
    else if (cfg.op === 'stop-host') await stopHost();
    else await finish({ type: 'failed' });
  } catch (error) {
    const allowed = ['archive-missing', 'descriptor-invalid', 'port-taken', 'host-busy', 'host-start-failed', 'host-timeout'];
    await finish({ type: 'error', reason: allowed.includes(error && error.message) ? error.message : 'host-start-failed' });
  }
})();
`

/**
 * Node's version check, run by each Node the probe finds. Old syntax on purpose, so a Node too old to run
 * the launch script still answers. Prints the version and exits 0 when it satisfies the archive's
 * `runtime-manifest.json` range (the desktop's range for an archive without one), 3 when too old and 4
 * when too new.
 */
export const NODE_CHECK_SOURCE = String.raw`var v = process.versions.node, c = {}, r = '';
try { c = JSON.parse(process.argv[1]); r = String(c.nodeRange || ''); } catch (e) {}
try { var path = require('path'), p = String(c.installPath || ''); if (p.slice(0, 2) === '~/') p = path.join(require('os').homedir(), p.slice(2)); var m = JSON.parse(require('fs').readFileSync(path.join(p, 'runtime-manifest.json'), 'utf8')); if (typeof m.node === 'string') r = m.node; } catch (e) {}
function parts(s) { var a = String(s).split('.'); return [parseInt(a[0], 10) || 0, parseInt(a[1], 10) || 0, parseInt(a[2], 10) || 0]; }
function compare(a, b) { for (var i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; }
var have = parts(v), code = 0;
r.split(/\s+/).forEach(function (t) { var x = /^(>=|<)(\d+(?:\.\d+){0,2})$/.exec(t); if (!x) return; var d = compare(have, parts(x[2])); if (x[1] === '>=' && d < 0) code = 3; else if (x[1] === '<' && d >= 0 && code === 0) code = 4; });
process.exitCode = code; process.stdout.write(v);
`

/**
 * The POSIX shell that finds Node before the launch script runs. A non-interactive SSH shell often lacks
 * the PATH a version manager sets up, so it tries the plain PATH, then the account's login shell, then
 * the places nvm, fnm, mise, asdf, Volta and Homebrew keep Node, and runs the launch script (read from
 * its stdin, which no probe touches) on the first that satisfies the range. When none does, it prints
 * the typed reason itself: `node-missing`, or the first version it found as too old or too new.
 * `$1` is the configuration JSON and `$2` the version check.
 */
export const NODE_PROBE_SOURCE = String.raw`cfg=$1
check=$2
seen=
seen_rc=
use_node() {
  [ -n "$1" ] && [ -x "$1" ] || return 0
  version=$("$1" -e "$check" "$cfg" </dev/null 2>/dev/null)
  rc=$?
  case $version in ''|*[!0-9.]*) return 0 ;; esac
  if [ "$rc" -eq 0 ]; then exec "$1" --input-type=commonjs - "$cfg"; fi
  if [ -z "$seen" ]; then seen=$version; seen_rc=$rc; fi
  return 0
}
use_node "$(command -v node 2>/dev/null)"
use_node "$("${'$'}{SHELL:-/bin/sh}" -l -c 'command -v node' </dev/null 2>/dev/null | tail -n 1)"
for candidate in "${'$'}{VOLTA_HOME:-$HOME/.volta}/bin/node" "$HOME/.local/share/mise/shims/node" "$HOME/.asdf/shims/node" \
  "${'$'}{FNM_DIR:-$HOME/.local/share/fnm}/aliases/default/bin/node" "$HOME/.fnm/aliases/default/bin/node" \
  "${'$'}{NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/node "${'$'}{FNM_DIR:-$HOME/.local/share/fnm}"/node-versions/*/installation/bin/node \
  "$HOME/.local/share/mise/installs/node"/*/bin/node /usr/local/bin/node /opt/homebrew/bin/node; do
  use_node "$candidate"
done
if [ -n "$seen" ]; then
  if [ "$seen_rc" -eq 4 ]; then reason=node-too-new; else reason=node-too-old; fi
  printf '{"type":"error","reason":"%s","version":"%s"}\n' "$reason" "$seen"
else
  printf '{"type":"error","reason":"node-missing"}\n'
fi
`

/** The range a host archive declares in its manifest; the desktop sends it for an archive without one. */
export const HOST_NODE_RANGE = `>=${HOST_NODE_MAJOR} <${HOST_NODE_MAJOR + 1}`
/** How long Stop host lets a host finish its running turns after SIGTERM before the script kills it. */
export const HOST_STOP_DRAIN_MS = 15_000
/**
 * How long the desktop gives a stop once SSH is signed in: the drain, the kill and the reply's trip back
 * over SSH. Shorter, and the desktop would report a failure while the stop was still going.
 */
export const HOST_STOP_REPLY_MS = HOST_STOP_DRAIN_MS + 5_000

export type LaunchOperation =
  | { readonly op: 'launch' }
  | { readonly op: 'pairing-code'; readonly hostId: string }
  | { readonly op: 'revoke-client'; readonly hostId: string; readonly clientId: string }
  | { readonly op: 'stop-host'; readonly hostId: string }

/** The configuration the launch script reads from its argument. It carries paths and IDs, never a secret. */
export function launchConfiguration(configuration: ValidatedSshHostConfiguration, operation: LaunchOperation, readyTimeoutMs: number): string {
  return JSON.stringify({ ...operation, installPath: configuration.installPath, dataDirectory: configuration.dataDirectory,
    remotePort: configuration.remotePort, readyTimeoutMs, stopDrainMs: HOST_STOP_DRAIN_MS, nodeRange: HOST_NODE_RANGE })
}

/**
 * The remote command for one operation: `sh -c <probe> sotto-launch <configuration> <check>`, each part
 * quoted for the account's shell, which OpenSSH always passes a remote command through. The launch
 * script itself goes on stdin.
 */
export function launchScriptCommand(configuration: ValidatedSshHostConfiguration, operation: LaunchOperation, readyTimeoutMs: number): string {
  return ['sh', '-c', NODE_PROBE_SOURCE, 'sotto-launch', launchConfiguration(configuration, operation, readyTimeoutMs), NODE_CHECK_SOURCE]
    .map(quoteRemoteArgument).join(' ')
}
