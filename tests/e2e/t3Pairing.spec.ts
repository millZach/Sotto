import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createPackage } from '@electron/asar'
import { expect, test } from '@playwright/test'
import { build } from 'esbuild'
import { requireOwnedE2EProfile } from '../../scripts/e2e-profile-policy.mjs'

const execFileAsync = promisify(execFile)

test('local pairing discovers a T3 server archive from the Electron main process', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop installation discovery')
  const root = await mkdtemp(join(tmpdir(), 'sotto-e2e-t3-pairing-'))
  try {
    const install = join(root, 'Programs', 't3code')
    const resources = join(install, 'resources')
    const source = join(root, 'archive-source')
    await mkdir(join(source, 'apps', 'server', 'dist'), { recursive: true })
    await mkdir(resources, { recursive: true })
    await writeFile(join(source, 'apps', 'server', 'dist', 'bin.mjs'), '// Fixture CLI entry')
    await writeFile(join(install, 'T3 Code (Alpha).exe'), 'Fixture executable; never launched')
    await createPackage(source, join(resources, 'server.asar'))
    await build({ entryPoints: ['src/main/agents/t3.ts'], outfile: join(root, 'host.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
    const runner = join(root, 'probe.cjs')
    await writeFile(runner, `
      const { app } = require('electron');
      let cliCalls = 0;
      let exchanged = false;
      // The filesystem and Electron archive handling are real. Only the T3
      // process and network effects are controlled; no local account is paired.
      require('node:child_process').execFile = (_exe, args, options, callback) => {
        if (!args[0].endsWith('bin.mjs') || options.env.ELECTRON_RUN_AS_NODE !== '1') throw new Error('Invalid CLI invocation');
        cliCalls++;
        callback(null, JSON.stringify({ credential: 'fixture-pairing-code' }), '');
      };
      // execFile's promisified API returns both streams, unlike the default
      // single-value callback wrapper. Preserve that native effect contract.
      const cli = require('node:child_process').execFile;
      cli[require('node:util').promisify.custom] = (...args) => new Promise((resolve, reject) => {
        cli(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
      });
      globalThis.fetch = async (input, options) => {
        const path = new URL(String(input)).pathname;
        if (path === '/.well-known/t3/environment') return Response.json({ serverVersion: '0.0.38' });
        if (path === '/oauth/token' && new URLSearchParams(options.body).get('subject_token') === 'fixture-pairing-code') {
          exchanged = true;
          return Response.json({ token_type: 'Bearer', access_token: 'fixture-client-session' });
        }
        throw new Error('Unexpected network request');
      };
      app.whenReady().then(async () => {
        const { T3CodeHost } = require('./host.cjs');
        const host = new T3CodeHost({ onCredential() { throw new Error('Fixture stops after successful pairing'); } });
        let error = '';
        try { await host.connect({ endpoint: 'http://127.0.0.1:3773', credential: '' }); }
        catch (failure) { error = failure.message; }
        finally { host.disconnect(); }
        console.log('PAIRING_RESULT=' + JSON.stringify({ cliCalls, exchanged, error }));
        app.exit(0);
      }).catch(() => app.exit(1));
    `)
    const env = Object.fromEntries(Object.entries({ ...process.env, LOCALAPPDATA: root })
      .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
    const { stdout } = await execFileAsync(join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe'), [runner], {
      env, windowsHide: true, timeout: 20_000,
    })
    const result = JSON.parse(stdout.split(/\r?\n/u).find(line => line.startsWith('PAIRING_RESULT='))!.slice('PAIRING_RESULT='.length))
    expect(result, 'T3 must be discoverable through Electron archive handling').toEqual({
      cliCalls: 1, exchanged: true, error: 'Fixture stops after successful pairing',
    })
  } finally { await rm(requireOwnedE2EProfile(root), { recursive: true, force: true }) }
})
