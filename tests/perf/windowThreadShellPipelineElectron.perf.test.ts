// @vitest-environment node
// SOTTO_PERF_BENCH=1 npx vitest run tests/perf/windowThreadShellPipelineElectron.perf.test.ts --maxWorkers=1 --disable-console-intercept
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { build } from 'esbuild'
import { _electron as electron } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import { median, PERF_BENCH } from '../fixtures/perfBench'

describe.skipIf(!PERF_BENCH)('actual Electron streaming desktop pipeline (#991)', () => {
  it('reports main thread and renderer CPU with the full projected shell and retained details', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-window-pipeline-entry-'))
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-window-pipeline-entry-')) throw new Error('Unexpected fixture directory')
    const main = join(root, 'main.cjs'), preload = join(root, 'preload.cjs'), page = join(root, 'page.js')
    await writeFile(preload, `const {contextBridge,ipcRenderer}=require('electron');let start;
      const receivers={};for(const channel of ['shell','detail'])ipcRenderer.on(channel,(_event,payload)=>receivers[channel]?.(payload));
      contextBridge.exposeInMainWorld('bench',{onState:listener=>{receivers.shell=listener},onDetail:listener=>{receivers.detail=listener},
        get:()=>ipcRenderer.invoke('get'), startCpu:()=>{start=process.cpuUsage()},endCpu:()=>{const used=process.cpuUsage(start);return{cpuMs:(used.user+used.system)/1000}},
        measure:options=>ipcRenderer.invoke('measure',options)});`)
    await build({ stdin: { contents: `import {wrapAgentBridge} from './src/renderer/src/agents/agentStateCatalogs';
      import {createStateSharing} from './src/renderer/src/agents/stateSharing';
      import {applyAgentThreadDetailDelta,isAgentThreadDetailDelta} from './src/shared/agentThreadDetail';
      window.restart=()=>{const held=new Map();const share=createStateSharing();let shell=null;window.lastState=null;
        const assemble=()=>{if(!shell)return;const state={...shell,host:{...shell.host,threads:shell.host.threads.map(thread=>{
          const detail=held.get(thread.id);return detail?{...thread,messages:detail.messages,...(detail.activities===undefined?{}:{activities:detail.activities})}:thread;
        })}};window.lastState=share(window.lastState,state)};
        wrapAgentBridge({get:window.bench.get,onState:window.bench.onState}).onState(state=>{shell=state;assemble()});
        window.bench.onDetail(update=>{const previous=held.get(update.threadId);const detail=isAgentThreadDetailDelta(update)?(previous?applyAgentThreadDetailDelta(previous,update):null):update;
          if(!detail)throw Error('Unexpected detail revision miss');held.set(detail.threadId,detail);assemble()});
      };window.restart();`, resolveDir: process.cwd() }, bundle: true, platform: 'browser', outfile: page })
    await build({ stdin: { contents: `import {app,BrowserWindow,ipcMain} from 'electron';
      import {measureElectronStreaming} from './tests/fixtures/windowThreadShellElectronPipeline';
      let window;app.setPath('userData',${JSON.stringify(join(root, 'profile'))});
      ipcMain.handle('get',()=>{throw Error('Unexpected shell recovery')});
      ipcMain.handle('measure',async(_event,{streamCount,enabled})=>{await window.webContents.executeJavaScript('window.restart()');return measureElectronStreaming(window,streamCount,enabled)});
      app.whenReady().then(async()=>{window=new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,sandbox:false}});
        await window.loadURL('data:text/html,<title>Streaming pipeline fixture</title>');await window.webContents.executeJavaScript(require('node:fs').readFileSync(${JSON.stringify(page)},'utf8'))});`, resolveDir: process.cwd() }, bundle: true, platform: 'node', external: ['electron', 'node-pty', 'sherpa-onnx-node'], outfile: main })
    let app: Awaited<ReturnType<typeof electron.launch>> | undefined
    try {
      app = await electron.launch({ args: [main], env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE')) })
      const window = await app.firstWindow()
      await window.waitForFunction(() => 'lastState' in window)
      for (const streamCount of [1, 3, 6]) for (const enabled of [false, true, true, false]) {
        const result = await window.evaluate(async options => (window as unknown as { bench: { measure: (options: unknown) => Promise<{ rows: Record<string, number>[]; shape: { threads: number; projects: number; models: number }; [key: string]: unknown }> } }).bench.measure(options), { enabled, streamCount })
        expect(result.shape.threads).toBe(204)
        expect(result.shape.projects).toBe(43)
        const rows = result.rows
        const medians = Object.fromEntries(Object.keys(rows[0]!).map(key => [key, median(rows.map(row => row[key]!))]))
        console.log(`Electron streaming pipeline: ${JSON.stringify({ ...result, medians })}`)
      }
    } finally {
      await app?.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 420_000)
})
