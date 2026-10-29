// @vitest-environment node
// SOTTO_PERF_BENCH=1 npx vitest run tests/perf/watcherRoomPipeline.perf.test.ts --maxWorkers=1 --disable-console-intercept
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { build } from 'esbuild'
import { _electron as electron } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import { bundleDesktopMain } from '../fixtures/desktopMainBundle'
import { median, PERF_BENCH } from '../fixtures/perfBench'

describe.skipIf(!PERF_BENCH)('actual Electron Watcher room pipeline (#991)', () => {
  it('reports owned desktop room IPC and main plus renderer cost at 1, 3 and 6 streams', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-watcher-room-entry-'))
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-watcher-room-entry-')) throw new Error('Unexpected owned fixture path')
    const main = join(root, 'main.cjs'), preload = join(root, 'preload.cjs'), page = join(root, 'page.js')
    // Main's room updates reach the page through the real preload's forwarding, on the real channel, and the page puts
    // the room back together on its side of the context bridge (#1450, #1759). Each send's source revision comes just
    // before it on a channel of the benchmark's own.
    await build({ stdin: { contents: `import {contextBridge,ipcRenderer} from 'electron';
      import {watcherRoomForwarding} from './src/preload/watcherRoomForwarding';let start,roomRevision=0,offRoom;const receivers={};
      const onRoomChanged=watcherRoomForwarding(ipcRenderer);ipcRenderer.on('room-revision',(_event,revision)=>{roomRevision=revision});
      for(const channel of ['shell','detail'])ipcRenderer.on(channel,(_event,value,revision)=>receivers[channel]?.(value,revision));contextBridge.exposeInMainWorld('bench',{
      onRoom:listener=>{offRoom?.();offRoom=onRoomChanged(change=>listener(change,roomRevision))},onState:listener=>{receivers.shell=listener},onDetail:listener=>{receivers.detail=listener},
      get:()=>ipcRenderer.invoke('get'),startCpu:()=>{start=process.cpuUsage()},endCpu:()=>{const used=process.cpuUsage(start);return{cpuMs:(used.user+used.system)/1000}},
      measure:options=>ipcRenderer.invoke('measure',options)});`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: preload })
    await build({ stdin: { contents: `import {wrapAgentBridge} from './src/renderer/src/agents/agentStateCatalogs';
      import {createRoomCompletion} from './tests/fixtures/watcherRoomCompletion';
      import {watcherRoomChanges} from './src/shared/watcherRoomChanges';
      import {createStateSharing} from './src/renderer/src/agents/stateSharing';
      import {applyAgentThreadDetailDelta,isAgentThreadDetailDelta} from './src/shared/agentThreadDetail';
      window.restart=()=>{const held=new Map(),share=createStateSharing();let shell=null,last=null;
      const assemble=()=>{if(!shell)return;last=share(last,{...shell,host:{...shell.host,threads:shell.host.threads.map(thread=>{
        const detail=held.get(thread.id);return detail?{...thread,messages:detail.messages,...(detail.activities===undefined?{}:{activities:detail.activities})}:thread})}})};
      wrapAgentBridge({get:window.bench.get,onState:window.bench.onState}).onState(value=>{shell=value;assemble()});
      window.bench.onDetail(update=>{const previous=held.get(update.threadId),detail=isAgentThreadDetailDelta(update)?(previous?applyAgentThreadDetailDelta(previous,update):null):update;
        if(!detail)throw Error('Unexpected detail miss');held.set(detail.threadId,detail);assemble()});
      const completion=createRoomCompletion(()=>window.bench.endCpu().cpuMs);
      window.completeRoom=(target,timeout)=>completion.wait(target,timeout);
      let roomRevision=0;const onRoom=watcherRoomChanges({onChanged:listener=>{window.bench.onRoom((change,revision)=>{roomRevision=revision;listener(change)});return()=>undefined},
        get:()=>Promise.reject(Error('Unexpected room recovery'))});
      window.room=null;onRoom(value=>{window.room=value;completion.receive(value,roomRevision)})};window.restart();`, resolveDir: process.cwd() }, bundle: true, platform: 'browser', outfile: page })
    // Main's half runs main's own Watcher room and socket client, whose words are messages, so it is built as main is.
    await bundleDesktopMain('watcherRoomPipelineMain.ts', main, { external: ['electron'], contents: `import './src/main/interfaceLanguage';
      import {app,BrowserWindow,ipcMain} from 'electron';
      import {measureWatcherRoom} from './tests/fixtures/watcherRoomPipeline';let window;
      app.setPath('userData',${JSON.stringify(join(root, 'profile'))});
      ipcMain.handle('get',()=>{throw Error('Unexpected shell recovery')});
      ipcMain.handle('sotto:watcher:get',()=>{throw Error('Unexpected room recovery')});
      ipcMain.handle('measure',async(_event,{streamCount,enabled})=>{await window.webContents.executeJavaScript('window.restart()');return measureWatcherRoom(window,streamCount,enabled)});
      app.whenReady().then(async()=>{window=new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,sandbox:false}});
      await window.loadURL('data:text/html,<title>Watcher room pipeline fixture</title>');
      await window.webContents.executeJavaScript(require('node:fs').readFileSync(${JSON.stringify(page)},'utf8'))});` })
    let app: Awaited<ReturnType<typeof electron.launch>> | undefined
    try {
      app = await electron.launch({ args: [main], env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE')) })
      const window = await app.firstWindow()
      await window.waitForFunction(() => 'room' in window)
      for (const streamCount of [1, 3, 6]) for (const enabled of [false, true, true, false]) {
        const result = await window.evaluate(async options => (window as unknown as { bench: { measure: (options: unknown) => Promise<{ rows: Record<string, number>[]; shape: { threads: number; watchedTargets: number }; [key: string]: unknown }> } }).bench.measure(options), { enabled, streamCount })
        expect(result.shape.threads).toBe(204)
        expect(result.shape.watchedTargets).toBe(streamCount)
        const medians = Object.fromEntries(Object.keys(result.rows[0]!).map(key => [key, median(result.rows.map(row => row[key]!))]))
        console.log(`Electron Watcher room pipeline: ${JSON.stringify({ ...result, medians })}`)
      }
    } finally {
      await app?.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 900_000)
})
