// @vitest-environment node
// SOTTO_PERF_BENCH=1 npx vitest run tests/perf/windowThreadShellElectron.perf.test.ts --maxWorkers=1 --disable-console-intercept
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { _electron as electron } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import { PERF_BENCH } from '../fixtures/perfBench'

describe.skipIf(!PERF_BENCH)('actual Electron desktop thread boundary (#991)', () => {
  it('includes IPC and contextBridge plus private page reconstruction CPU', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-window-boundary-'))
    const main = join(root, 'main.cjs'), preload = join(root, 'preload.cjs'), page = join(root, 'page.js')
    await writeFile(preload, `const {contextBridge,ipcRenderer}=require('electron');
      const {PerformanceObserver}=require('node:perf_hooks'); let gcMs=0;
      const observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())gcMs+=entry.duration});observer.observe({entryTypes:['gc']});
      let receive=()=>{};ipcRenderer.on('shell', (_event,payload) => {
        const start=process.cpuUsage(); const began=performance.now(); receive(payload);
        const used=process.cpuUsage(start); ipcRenderer.send('ack',{cpuUs:used.user+used.system,wallMs:performance.now()-began});
      });contextBridge.exposeInMainWorld('bench', {onState: listener => {receive=listener}, measure: async options=>{const cpu=process.cpuUsage(); const gc=gcMs;const result=await ipcRenderer.invoke('measure',options);
        const used=process.cpuUsage(cpu);result.rendererProcessCpuMs=(used.user+used.system)/1000/220;
        result.totalProcessCpuMs=result.mainProcessCpuMs+result.rendererProcessCpuMs;result.rendererGcMs=gcMs-gc;return result}});`)
    await build({ stdin: { contents: `import {wrapAgentBridge} from './src/renderer/src/agents/agentStateCatalogs';
      import {createStateSharing} from './src/renderer/src/agents/stateSharing';
      window.restart=()=>{const bridge={get:async()=>{throw Error('Unexpected recovery')},onState:window.bench.onState};
        const share=createStateSharing(); window.lastState=null;
        wrapAgentBridge(bridge).onState(state=>{window.lastState=share(window.lastState,state)});};window.restart();`, resolveDir: process.cwd() }, bundle: true, platform: 'browser', outfile: page })
    await build({ stdin: { contents: `import {app,BrowserWindow,ipcMain} from 'electron';
      import {serialize} from 'node:v8';
      import {PerformanceObserver} from 'node:perf_hooks';
      import {AgentStateBroadcaster} from './src/main/agents/agentStateBroadcast';
      import {windowThreadShellFixture} from './tests/fixtures/windowThreadShell';
      const preload=${JSON.stringify(preload)},page=${JSON.stringify(page)};
      let window, acknowledge, gcMs=0;
      const observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())gcMs+=entry.duration});observer.observe({entryTypes:['gc']});
      ipcMain.on('ack',(_event,value)=>{acknowledge(value)});
      ipcMain.handle('measure',async(_event,{enabled,changed})=>{
        await window.webContents.executeJavaScript('window.restart()');
        const state=windowThreadShellFixture(); let broadcaster=new AgentStateBroadcaster({streamingPublishCost:enabled});
        let last,rendererCpuUs=0,rendererWallMs=0;
        const publish=()=>new Promise(resolve=>{if(changed<0)broadcaster=new AgentStateBroadcaster({streamingPublishCost:enabled});acknowledge=resolve;broadcaster.send(state,payload=>{last=payload;window.webContents.send('shell',payload);return true})});
        const processCpu=process.cpuUsage();for(let i=0;i<20;i++)await publish();
        const cpu=process.cpuUsage(); const began=performance.now(); const gc=gcMs;
        for(let i=0;i<200;i++){
          for(let n=0;n<changed;n++)state.host.threads[n].summary.lastAssistant.text='Synthetic progress '+i;
          const ack=await publish();rendererCpuUs+=ack.cpuUs;rendererWallMs+=ack.wallMs;
        }
        const used=process.cpuUsage(cpu),processUsed=process.cpuUsage(processCpu);
        return {enabled,changed,bytes:serialize(last).length,mainCpuMs:(used.user+used.system)/1000/200,
          mainProcessCpuMs:(processUsed.user+processUsed.system)/1000/220,
          rendererCpuMs:rendererCpuUs/1000/200,totalCpuMs:(used.user+used.system+rendererCpuUs)/1000/200,
          wallMs:(performance.now()-began)/200,rendererBoundaryWallMs:rendererWallMs/200,mainGcMs:gcMs-gc,threads:state.host.threads};
      });
      app.whenReady().then(async()=>{window=new BrowserWindow({show:false,webPreferences:{preload,contextIsolation:true,sandbox:false}});
        await window.loadURL('data:text/html,<title>Thread boundary fixture</title>');await window.webContents.executeJavaScript(require('node:fs').readFileSync(page,'utf8'));
      });`, resolveDir: process.cwd() }, bundle: true, platform: 'node', external: ['electron'], outfile: main })
    let app: Awaited<ReturnType<typeof electron.launch>> | undefined
    try {
      app = await electron.launch({ args: [main], env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE')) })
      const window = await app.firstWindow()
      await window.waitForFunction(() => 'lastState' in window)
      const changes = process.env.SOTTO_STEP4_COLD_ONLY === '1' ? [-1] : [-1, 0, 1, 3, 6]
      for (const changed of changes) for (const enabled of [false, true, true, false]) {
        const result = await window.evaluate(async options => (window as unknown as { bench: { measure: (options: unknown) => Promise<Record<string, unknown>> } }).bench.measure(options), { enabled, changed })
        const threads = result.threads
        delete result.threads
        expect(await window.evaluate(() => (window as unknown as { lastState: { host: { threads: unknown } } }).lastState.host.threads)).toEqual(threads)
        console.log(`Electron thread boundary: ${JSON.stringify(result)}`)
      }
    } finally {
      await app?.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 180_000)
})
