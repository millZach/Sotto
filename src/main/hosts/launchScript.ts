import { HOST_NODE_MAJOR } from './sshFailure'
import { quoteRemoteArgument, type ValidatedSshHostConfiguration } from './sshConfiguration'
import { desktopAnswerSetupSql } from '../memory/migrations.mjs'

/**
 * The launch script: fixed Node source the desktop pipes to one `ssh` command per operation. It finds or
 * starts the host, asks it for a pairing code, revokes a client, stops a host Sotto started, or takes one
 * step of a host update, writes one JSON result line to stdout and exits. The source travels on stdin, so
 * it is never in the remote process list; the configuration, which holds no secret, is a separately
 * quoted JSON argument.
 *
 * A host the script starts is told so through SOTTO_HOST_STARTED_BY, and records it in its own
 * listener descriptor once it holds the data folder's lock. That descriptor is what makes a host
 * "started by Sotto": only the host holding the lock writes it, so two launches racing cannot take
 * the mark from each other, and it stays true across every later reconnect.
 *
 * The installation folder holds either one flat install (`host/index.js` in the folder itself, as every
 * install before host updates) or versions side by side under `versions/<X.Y.Z>/`, with a `current` file
 * naming the one to start (ADR-0040). The script starts the version `current` names when it is there, and
 * the flat install otherwise, so an install from before this keeps starting as it did.
 *
 * An update is three operations the desktop runs in turn, each under the folder's update lock:
 * `update-fetch` downloads the release archive and its checksum on the host; `update-install` checks the
 * archive against the checksum it is given and unpacks it into its own version folder, beside the one
 * running; `update-restart` points `current` at it, stops the running host the way Stop host does and starts
 * the new one, and when that one does not start, points `current` back and starts the old one again. When
 * the host cannot download, the desktop downloads the archive and copies it into place with the receive
 * script below before `update-install`.
 */
export const LAUNCH_SCRIPT_SOURCE = String.raw`'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const cfg = JSON.parse(process.argv[process.argv[1] === '-' ? 2 : 1]);
const resolvePath = value => path.resolve(value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value);
const data = resolvePath(cfg.dataDirectory);
const install = resolvePath(cfg.installPath);
const descriptorPath = path.join(data, 'host-listener.json');
// Written by launch scripts before a host recorded its own start. Read so a host started that way stays stoppable; never written.
const legacyLauncherPath = path.join(data, 'host-launcher.json');
const lockPath = path.join(data, 'host-listener.lock');
const RELEASE = /^\d+\.\d+\.\d+$/;
const ARCHIVE = /^Sotto-host-\d+\.\d+\.\d+-[a-z0-9]+-[a-z0-9]+\.tar\.gz$/;
const versionsPath = path.join(install, 'versions');
const incomingPath = path.join(versionsPath, '.incoming');
const pointerPath = path.join(install, 'current');
const updateLockPath = path.join(versionsPath, '.update-lock');
const updating = typeof cfg.op === 'string' && cfg.op.startsWith('update-');
// Unpacking and restarting carry on when the desktop's connection drops partway, so a host a restart stopped is always
// started again. A download ends with the connection, as Cancel update expects.
const finishesAlone = cfg.op === 'update-install' || cfg.op === 'update-restart';
process.stdout.on('error', () => { if (!finishesAlone) process.exit(0); });
if (finishesAlone) process.on('SIGHUP', () => undefined);
const say = event => new Promise(resolve => { if (process.stdout.destroyed) { resolve(); return; } process.stdout.write(JSON.stringify(event) + '\n', () => resolve()); });
const finish = async event => { await say(event); process.exit(0); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = async file => { try { await fs.access(file); return true; } catch { return false; } };
// The host's own rule: a process another account owns (EPERM) is still running.
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return !!error && error.code === 'EPERM'; } };
// Match src/host/lock.ts: an earlier boot cannot still own a lease, even if its PID was reused.
const runBootProbe = (file, args) => new Promise((resolve, reject) => execFile(file, args, { timeout: 5000, windowsHide: true, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout)));
const readBootId = async () => {
  try {
    let value;
    if (process.platform === 'linux') value = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    else if (process.platform === 'darwin') value = (await runBootProbe('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'])).trim();
    else if (process.platform === 'win32') {
      const output = await runBootProbe('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters', '/v', 'BootId']);
      value = /BootId\s+REG_DWORD\s+(0x[0-9a-f]+)/i.exec(output)?.[1]?.toLowerCase();
    }
    return value ? process.platform + ':' + value : undefined;
  } catch { return undefined; }
};
const bootIdentity = readBootId();
// The version the current pointer names, or null for a flat install.
const currentVersion = async () => { try { const value = (await fs.readFile(pointerPath, 'utf8')).trim(); return RELEASE.test(value) ? value : null; } catch { return null; } };
const entryOf = version => version ? path.join(versionsPath, version, 'host', 'index.js') : path.join(install, 'host', 'index.js');
const hostEntry = async () => { const version = await currentVersion(); return version && await exists(entryOf(version)) ? entryOf(version) : entryOf(null); };
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
  // The host that wrote it has gone, as one an update just stopped has: its port may not refuse a connection cleanly yet.
  if (!alive(descriptor.pid)) return null;
  let live;
  try { live = await health(descriptor.port); }
  catch (error) { if (error.code === 'ECONNREFUSED') return null; throw new Error('port-taken'); }
  if (live.hostId !== descriptor.hostId || live.pid !== descriptor.pid) throw new Error('port-taken');
  const legacy = await readLegacyLauncher();
  const owned = descriptor.startedBy === 'launch-script' || (!!legacy && legacy.pid === live.pid);
  return { v: 1, status: 'ready', hostId: live.hostId, pid: live.pid, port: live.port, owned };
};
// Whether something already listens on the host's fixed port, which a host that could not start was asked to use.
const portAnswers = port => new Promise(resolve => {
  if (!Number.isInteger(port) || port < 1) { resolve(false); return; }
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.setTimeout(1000);
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('timeout', () => { socket.destroy(); resolve(false); });
  socket.once('error', () => resolve(false));
});
const lockHolder = async () => {
  try {
    const value = JSON.parse(await fs.readFile(lockPath, 'utf8')), boot = await bootIdentity;
    if (typeof value.boot === 'string' && boot !== undefined && value.boot !== boot) return null;
    return Number.isInteger(value.pid) && value.pid > 0 && alive(value.pid) ? value.pid : null;
  }
  catch { return null; }
};
// Finds the running host, or starts the one the installation folder names, and answers once it listens.
const start = async () => {
  const existing = await discover();
  if (existing) return { type: 'ready', ...existing };
  // A live process holds the folder but is not listening yet: another client may have started it a moment ago. Wait for it rather than racing it.
  const holder = await lockHolder();
  if (holder !== null) {
    await say({ type: 'starting' });
    const deadline = Date.now() + cfg.readyTimeoutMs;
    while (Date.now() < deadline && alive(holder)) {
      const current = await discover();
      if (current) return { type: 'ready', ...current };
      await pause(100);
    }
    if (alive(holder)) throw new Error('host-busy');
  }
  const entry = await hostEntry();
  if (!(await exists(entry))) throw new Error('archive-missing');
  await say({ type: 'starting' });
  const child = spawn(process.execPath, [entry, '--data', data, '--port', String(cfg.remotePort)], { detached: true, stdio: 'ignore', env: { ...process.env, SOTTO_HOST_STARTED_BY: 'launch-script' } });
  child.unref();
  let childFailed = false; child.on('error', () => { childFailed = true; });
  const deadline = Date.now() + cfg.readyTimeoutMs;
  while (Date.now() < deadline) {
    const current = await discover();
    if (current) return { type: 'ready', ...current };
    // A child that lost the lock to a host another launch started a moment earlier exits at once; that host is waited for instead.
    if ((childFailed || child.exitCode !== null || child.signalCode !== null) && (await lockHolder()) === null) throw new Error((await portAnswers(cfg.remotePort)) ? 'port-taken' : 'host-start-failed');
    await pause(100);
  }
  if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGTERM'); } catch {} }
  throw new Error('host-timeout');
};
// A launch also hands back the host's administrative token, for the desktop on the other end of this session to
// administer the host's phone access through the port it forwards (ADR-0050), without signing in over SSH again.
// This account can read the descriptor already; the token travels only on this session's stdout, and the desktop
// keeps it in memory for this one connection.
const adminToken = async ready => {
  try {
    const value = JSON.parse(await fs.readFile(descriptorPath, 'utf8'));
    return value.hostId === ready.hostId && value.pid === ready.pid && typeof value.adminToken === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(value.adminToken) ? value.adminToken : undefined;
  } catch { return undefined; }
};
const launch = async () => { const ready = await start(); const token = await adminToken(ready); return finish(token ? { ...ready, adminToken: token } : ready); };
const admin = async () => {
  const current = await discover().catch(() => null);
  if (!current || current.hostId !== cfg.hostId) return finish({ type: 'failed' });
  const revoking = cfg.op === 'revoke-client';
  if (revoking && (typeof cfg.clientId !== 'string' || !cfg.clientId || cfg.clientId.length > 512)) return finish({ type: 'failed' });
  const child = spawn(process.execPath, [await hostEntry(), '--data', data, ...(revoking ? ['--revoke-client', cfg.clientId] : ['--pairing-code'])], { stdio: ['ignore', 'pipe', 'ignore'] });
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
// The authenticated SSH account establishes its desktop's default authority, through the same policy
// records the running host reads. One conditional write preserves revoked decisions and works with
// existing host archives, without exposing a new grant operation to paired socket clients.
const desktopAnswers = async () => {
  const current = await discover().catch(() => null);
  if (!current || current.hostId !== cfg.hostId || typeof cfg.clientId !== 'string' || !cfg.clientId || cfg.clientId.length > 512 || /[\p{Cc}]/u.test(cfg.clientId)) return finish({ type: 'failed' });
  let db;
  try {
    const paired = JSON.parse(await fs.readFile(path.join(data, 'paired-clients.json'), 'utf8'));
    if (!Array.isArray(paired.clients) || !paired.clients.some(client => client.clientId === cfg.clientId)) return finish({ type: 'failed' });
    const file = path.join(data, 'memory.sqlite');
    if (!(await fs.stat(file)).isFile()) return finish({ type: 'failed' });
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(file);
    db.exec('PRAGMA busy_timeout=10000');
    const scope = 'client:' + cfg.clientId;
    db.prepare(${JSON.stringify(desktopAnswerSetupSql)}).run(crypto.randomUUID(), 'remote-answer', cfg.clientId, scope, 'allow', 'user',
      "Sotto connected this desktop through the user's authenticated SSH session.", new Date().toISOString(), null, null, scope, cfg.clientId);
    return finish({ type: 'desktop-answers', hostId: current.hostId });
  } catch { return finish({ type: 'failed' }); }
  finally { if (db) db.close(); }
};
// SIGTERM, which a host answers by saving its workspace and exiting; one still running after the drain is killed.
const stopProcess = async pid => {
  try { process.kill(pid, 'SIGTERM'); } catch {}
  const deadline = Date.now() + cfg.stopDrainMs;
  while (alive(pid) && Date.now() < deadline) await pause(100);
  if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} await pause(200); }
  return !alive(pid);
};
const stopHost = async () => {
  const current = await discover().catch(() => null);
  if (!current) return finish({ type: 'host-stopped', stopped: true, hostId: null });
  if (current.hostId !== cfg.hostId || !current.owned) return finish({ type: 'host-stopped', stopped: false, hostId: current.hostId });
  const pid = current.pid;
  const stopped = await stopProcess(pid);
  const legacy = await readLegacyLauncher();
  if (stopped && legacy && legacy.pid === pid) await fs.rm(legacyLauncherPath, { force: true }).catch(() => undefined);
  return finish({ type: 'host-stopped', stopped, hostId: current.hostId });
};
// One update at a time in a folder, whichever client runs it. A lock whose process has gone, or that never named one, is taken over.
const takeUpdateLock = async () => {
  await fs.mkdir(versionsPath, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await fs.mkdir(updateLockPath); await fs.writeFile(path.join(updateLockPath, 'pid'), String(process.pid)); return; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    let pid = 0, age = Infinity;
    try { pid = Number(await fs.readFile(path.join(updateLockPath, 'pid'), 'utf8')); } catch {}
    try { age = Date.now() - (await fs.stat(updateLockPath)).mtimeMs; } catch {}
    if (Number.isInteger(pid) && pid > 0 ? alive(pid) : age < 30000) throw new Error('update-busy');
    await fs.rm(updateLockPath, { recursive: true, force: true });
  }
  throw new Error('update-busy');
};
const releaseUpdateLock = () => fs.rm(updateLockPath, { recursive: true, force: true }).catch(() => undefined);
const updateVersion = () => { if (typeof cfg.version !== 'string' || !RELEASE.test(cfg.version)) throw new Error('update-invalid'); return cfg.version; };
const archiveName = version => 'Sotto-host-' + version + '-' + process.platform + '-' + process.arch + '.tar.gz';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const writeAtomically = async (file, contents) => { const temporary = file + '.' + process.pid + '.tmp'; await fs.writeFile(temporary, contents); await fs.rename(temporary, file); };
const writePointer = async version => { if (version) await writeAtomically(pointerPath, version + '\n'); else await fs.rm(pointerPath, { force: true }); };
const versionParts = value => String(value).split('.').map(part => parseInt(part, 10) || 0).concat([0, 0, 0]).slice(0, 3);
const compareVersions = (a, b) => { for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index]; return 0; };
// The runtime manifest's range, read the way the Node check reads it: every >= and < it names.
const satisfies = (version, range) => String(range).split(/\s+/).every(token => {
  const match = /^(>=|<)(\d+(?:\.\d+){0,2})$/.exec(token);
  if (!match) return true;
  const difference = compareVersions(versionParts(version), versionParts(match[2]));
  return match[1] === '>=' ? difference >= 0 : difference < 0;
});
// A download stops once the ssh that asked for it has gone, as it has after Cancel update: without a terminal nothing
// else tells this process, and a download left running would only hold the installation folder's bandwidth. A POSIX
// process whose parent ends is given another one; Windows, where only Sotto's tests run this, keeps the old number.
const orphaned = new AbortController();
const parent = process.ppid;
setInterval(() => { if (process.ppid !== parent) orphaned.abort(); }, 500).unref();
const download = async (url, limit) => {
  if (typeof fetch !== 'function') throw new Error('download-unreachable');
  let response;
  try { response = await fetch(url, { redirect: 'follow', signal: AbortSignal.any([AbortSignal.timeout(cfg.downloadTimeoutMs), orphaned.signal]) }); }
  catch { throw new Error('download-unreachable'); }
  if (response.status === 404) throw new Error('archive-unavailable');
  if (!response.ok || !response.body) throw new Error('download-failed');
  const chunks = []; let size = 0;
  try { for await (const chunk of response.body) { size += chunk.length; if (size > limit) throw new Error('too-large'); chunks.push(Buffer.from(chunk)); } }
  catch { throw new Error('download-failed'); }
  return Buffer.concat(chunks);
};
// The .sha256 sidecar the release publishes beside each archive: a digest and the archive's name.
const publishedSum = (text, file) => { const match = /^([0-9a-fA-F]{64})\s+\*?(\S+)/.exec(String(text).trim()); return match && match[2] === file ? match[1].toLowerCase() : null; };
const fetchUpdate = async () => {
  const version = updateVersion(), file = archiveName(version);
  const url = String(cfg.releasesUrl).replace(/\/+$/, '') + '/v' + version + '/' + file;
  let archive, sidecar;
  try { archive = await download(url, cfg.archiveLimit); sidecar = await download(url + '.sha256', 4096); }
  catch (error) { return { type: 'error', reason: error.message, file }; }
  await say({ type: 'update-step', step: 'check' });
  const actual = sha256(archive);
  if (publishedSum(sidecar.toString('utf8'), file) !== actual) return { type: 'error', reason: 'checksum-mismatch', file };
  await fs.mkdir(incomingPath, { recursive: true });
  await writeAtomically(path.join(incomingPath, file), archive);
  return { type: 'update-fetched', file, sha256: actual };
};
const installUpdate = async () => {
  const version = updateVersion(), file = String(cfg.file);
  if (!ARCHIVE.test(file) || !/^[0-9a-f]{64}$/.test(String(cfg.sha256))) throw new Error('update-invalid');
  const archive = path.join(incomingPath, file);
  let bytes;
  try { bytes = await fs.readFile(archive); } catch { throw new Error('update-missing'); }
  if (sha256(bytes) !== cfg.sha256) { await fs.rm(archive, { force: true }); return { type: 'error', reason: 'checksum-mismatch' }; }
  await say({ type: 'update-step', step: 'install' });
  // Already the version current names, and so perhaps the one running: there is nothing to unpack.
  if ((await currentVersion()) === version && await exists(entryOf(version))) { await fs.rm(archive, { force: true }); return { type: 'update-installed', version }; }
  const target = path.join(versionsPath, version), partial = target + '.partial';
  await fs.rm(partial, { recursive: true, force: true });
  await fs.mkdir(partial, { recursive: true });
  // Paths relative to the installation folder, which every tar reads the same way.
  const code = await new Promise(resolve => {
    const child = spawn('tar', ['-xzf', 'versions/.incoming/' + file, '-C', 'versions/' + version + '.partial'], { cwd: install, stdio: 'ignore' });
    child.on('error', () => resolve(-1)); child.on('close', resolve);
  });
  const discard = async reason => { await fs.rm(partial, { recursive: true, force: true }).catch(() => undefined); return reason; };
  if (code !== 0) throw new Error(await discard('unpack-failed'));
  let manifest = {}, release = {};
  try { release = JSON.parse(await fs.readFile(path.join(partial, 'package.json'), 'utf8')); } catch {}
  try { manifest = JSON.parse(await fs.readFile(path.join(partial, 'runtime-manifest.json'), 'utf8')); } catch {}
  // The archive is the release it was asked for, and has a host in it.
  if (release.version !== version || !(await exists(path.join(partial, 'host', 'index.js')))) throw new Error(await discard('archive-invalid'));
  if (typeof manifest.node === 'string' && !satisfies(process.versions.node, manifest.node)) {
    await discard('node-unsupported');
    return { type: 'error', reason: 'node-unsupported', range: manifest.node.slice(0, 64), node: process.versions.node };
  }
  await fs.rm(target, { recursive: true, force: true });
  await fs.rename(partial, target);
  await fs.rm(archive, { force: true });
  return { type: 'update-installed', version };
};
// Keeps the version now running and the one before it; every other version folder, and anything half unpacked, goes.
const prune = async keep => {
  let names = [];
  try { names = await fs.readdir(versionsPath); } catch { return; }
  for (const name of names) {
    if ((RELEASE.test(name) && !keep.includes(name)) || name.endsWith('.partial')) await fs.rm(path.join(versionsPath, name), { recursive: true, force: true }).catch(() => undefined);
  }
};
const restartForUpdate = async () => {
  const version = updateVersion();
  if (!(await exists(entryOf(version)))) throw new Error('update-missing');
  const running = await discover().catch(() => null);
  if (!running || running.hostId !== cfg.hostId || !running.owned) return { type: 'error', reason: 'update-not-owned' };
  const previous = await currentVersion();
  await say({ type: 'update-step', step: 'restart' });
  await writePointer(version);
  if (!(await stopProcess(running.pid))) { await writePointer(previous); return { type: 'error', reason: 'update-stop-failed' }; }
  try {
    const ready = await start();
    await prune([version, previous]);
    return ready;
  } catch (error) {
    // The new version did not start: point back at the old one and start it again, whatever the pointer's write says.
    const cause = error && typeof error.message === 'string' && error.message.length <= 64 ? error.message : 'host-start-failed';
    await writePointer(previous).catch(() => undefined);
    try { await start(); return { type: 'error', reason: 'update-start-failed', restarted: true, cause }; }
    catch { return { type: 'error', reason: 'update-start-failed', restarted: false, cause }; }
  }
};
const runUpdate = async () => {
  // A download writes only its own file, so it runs without the lock: a cancelled one still finishing never holds up the next.
  if (cfg.op === 'update-fetch') return fetchUpdate();
  await takeUpdateLock();
  try {
    if (cfg.op === 'update-install') return await installUpdate();
    if (cfg.op === 'update-restart') return await restartForUpdate();
    return { type: 'failed' };
  } finally { await releaseUpdateLock(); }
};
(async () => {
  try {
    if (cfg.op === 'launch') await launch();
    else if (cfg.op === 'pairing-code' || cfg.op === 'revoke-client') await admin();
    else if (cfg.op === 'desktop-answers') await desktopAnswers();
    else if (cfg.op === 'stop-host') await stopHost();
    else if (updating) await finish(await runUpdate());
    else await finish({ type: 'failed' });
  } catch (error) {
    const allowed = ['archive-missing', 'descriptor-invalid', 'port-taken', 'host-busy', 'host-start-failed', 'host-timeout',
      'update-busy', 'update-invalid', 'update-missing', 'unpack-failed', 'archive-invalid'];
    await finish({ type: 'error', reason: allowed.includes(error && error.message) ? error.message : updating ? 'update-failed' : 'host-start-failed' });
  }
})();
`

/**
 * The receive script: what `update-receive` runs, as `node -e` so its stdin is free for the archive. It writes
 * exactly the bytes it is told to expect into the installation folder's incoming folder and says how many
 * arrived; `update-install` then checks them against the checksum. A copy cut short leaves nothing behind.
 */
export const RECEIVE_SCRIPT_SOURCE = String.raw`'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cfg = JSON.parse(process.argv[process.argv[1] === '-' ? 2 : 1]);
const say = event => process.stdout.write(JSON.stringify(event) + '\n');
const file = String(cfg.file);
if (!/^Sotto-host-\d+\.\d+\.\d+-[a-z0-9]+-[a-z0-9]+\.tar\.gz$/.test(file) || !Number.isInteger(cfg.size) || cfg.size < 1 || cfg.size > cfg.archiveLimit) { say({ type: 'error', reason: 'update-invalid' }); process.exit(0); }
const install = path.resolve(cfg.installPath.startsWith('~/') ? path.join(os.homedir(), cfg.installPath.slice(2)) : cfg.installPath);
const incoming = path.join(install, 'versions', '.incoming');
fs.mkdirSync(incoming, { recursive: true });
const target = path.join(incoming, file), partial = target + '.' + process.pid + '.part';
const output = fs.createWriteStream(partial);
let size = 0, ended = false;
const incomplete = () => { if (ended) return; ended = true; output.destroy(); fs.rmSync(partial, { force: true }); say({ type: 'error', reason: 'copy-incomplete' }); };
output.on('error', incomplete);
// The disk sets the pace: stdin waits while the file catches up, so an archive never piles up in memory.
process.stdin.on('data', chunk => {
  size += chunk.length;
  if (size > cfg.size) { incomplete(); process.stdin.destroy(); return; }
  if (!output.write(chunk)) { process.stdin.pause(); output.once('drain', () => process.stdin.resume()); }
});
process.stdin.on('error', incomplete);
process.stdin.on('end', () => output.end(() => {
  if (ended) return;
  if (size !== cfg.size) { incomplete(); return; }
  try { fs.renameSync(partial, target); } catch { incomplete(); return; }
  ended = true;
  say({ type: 'update-received', size });
}));
`

/**
 * Node's version check, run by each Node the probe finds. Old syntax on purpose, so a Node too old to run
 * the launch script still answers. Prints the version and exits 0 when it satisfies the archive's
 * `runtime-manifest.json` range (the desktop's range for an archive without one), 3 when too old and 4
 * when too new. The archive is the version `current` names when the folder holds versions side by side.
 */
export const NODE_CHECK_SOURCE = String.raw`var v = process.versions.node, c = {}, r = '';
try { c = JSON.parse(process.argv[1]); r = String(c.nodeRange || ''); } catch (e) {}
try { var path = require('path'), fs = require('fs'), p = String(c.installPath || ''); if (p.slice(0, 2) === '~/') p = path.join(require('os').homedir(), p.slice(2));
  try { var n = String(fs.readFileSync(path.join(p, 'current'), 'utf8')).trim(); if (/^\d+\.\d+\.\d+$/.test(n) && fs.existsSync(path.join(p, 'versions', n, 'host', 'index.js'))) p = path.join(p, 'versions', n); } catch (e) {}
  var m = JSON.parse(fs.readFileSync(path.join(p, 'runtime-manifest.json'), 'utf8')); if (typeof m.node === 'string') r = m.node; } catch (e) {}
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
 * `$1` is the configuration JSON and `$2` the version check. `$3`, when there is one, is a script to run
 * with `-e` instead, which leaves stdin free for what it reads: the receive script takes an archive there.
 * Its first line says SSH has signed in, which moves the Add host checklist on before the probe, which
 * can take a while, has found Node.
 */
export const NODE_PROBE_SOURCE = String.raw`printf '{"type":"signed-in"}\n'
cfg=$1
check=$2
inline=$3
seen=
seen_rc=
use_node() {
  [ -n "$1" ] && [ -x "$1" ] || return 0
  version=$("$1" -e "$check" "$cfg" </dev/null 2>/dev/null)
  rc=$?
  case $version in ''|*[!0-9.]*) return 0 ;; esac
  if [ "$rc" -eq 0 ] && [ -n "$inline" ]; then exec "$1" -e "$inline" "$cfg"; fi
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
/** How long a host has to download an archive and its checksum before the download counts as failed. */
export const HOST_DOWNLOAD_TIMEOUT_MS = 5 * 60_000
/**
 * The largest archive an update takes. Today's is about 1 MB; one that carries its own Node (#207) is tens of
 * megabytes. Anything larger is not a Sotto host.
 */
export const HOST_ARCHIVE_LIMIT_BYTES = 512 * 1024 * 1024

export type LaunchOperation =
  | { readonly op: 'launch' }
  | { readonly op: 'pairing-code'; readonly hostId: string }
  | { readonly op: 'desktop-answers'; readonly hostId: string; readonly clientId: string }
  | { readonly op: 'revoke-client'; readonly hostId: string; readonly clientId: string }
  | { readonly op: 'stop-host'; readonly hostId: string }
  /** Download `version`'s archive for the host's own platform, and its checksum, from `releasesUrl`, and check one against the other. */
  | { readonly op: 'update-fetch'; readonly version: string; readonly releasesUrl: string }
  /** Take `size` bytes of `file` on stdin, through the receive script. */
  | { readonly op: 'update-receive'; readonly file: string; readonly size: number }
  /** Check `file` against `sha256` and unpack it beside the version running. */
  | { readonly op: 'update-install'; readonly version: string; readonly file: string; readonly sha256: string }
  /** Start `version` in place of the running host, or start the running one again when it does not start. */
  | { readonly op: 'update-restart'; readonly hostId: string; readonly version: string }

/** The configuration the launch script reads from its argument. It carries paths, IDs and a release URL, never a secret. */
export function launchConfiguration(configuration: ValidatedSshHostConfiguration, operation: LaunchOperation, readyTimeoutMs: number): string {
  return JSON.stringify({ ...operation, installPath: configuration.installPath, dataDirectory: configuration.dataDirectory,
    remotePort: configuration.remotePort, readyTimeoutMs, stopDrainMs: HOST_STOP_DRAIN_MS, nodeRange: HOST_NODE_RANGE,
    downloadTimeoutMs: HOST_DOWNLOAD_TIMEOUT_MS, archiveLimit: HOST_ARCHIVE_LIMIT_BYTES })
}

/**
 * The remote command for one operation: `sh -c <probe> sotto-launch <configuration> <check>`, each part
 * quoted for the account's shell, which OpenSSH always passes a remote command through. The launch
 * script itself goes on stdin; for `update-receive`, the receive script goes as the probe's `$3` and the
 * archive on stdin.
 */
export function launchScriptCommand(configuration: ValidatedSshHostConfiguration, operation: LaunchOperation, readyTimeoutMs: number): string {
  return ['sh', '-c', NODE_PROBE_SOURCE, 'sotto-launch', launchConfiguration(configuration, operation, readyTimeoutMs), NODE_CHECK_SOURCE,
    ...(operation.op === 'update-receive' ? [RECEIVE_SCRIPT_SOURCE] : [])]
    .map(quoteRemoteArgument).join(' ')
}
