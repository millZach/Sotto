/* global console, process, document, window, localStorage, AudioContext, setTimeout, atob */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'

const dir=resolve(process.argv[2]),url=process.argv[3]||'http://127.0.0.1:5187/listening.html'
const entry=join(dir,'verify-app.cjs')
writeFileSync(entry,`const {app,BrowserWindow}=require('electron');const {mkdtempSync}=require('node:fs');const {tmpdir}=require('node:os');const {join}=require('node:path');app.setPath('userData',mkdtempSync(join(tmpdir(),'sotto-tts-qa-')));app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1100,height:980,webPreferences:{contextIsolation:true,nodeIntegration:false}});w.loadURL(${JSON.stringify(url)});});`)
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
const app=await electron.launch({args:[entry],env})
const errors=[]
try{
  const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message))
  await page.waitForSelector('.voice')
  assert.equal(await page.locator('.voice').count(),4)
  assert.equal(await page.locator('#fixture option').count(),24)
  await page.locator('input[aria-label="Prefer voice A"]').check()
  await page.locator('#note').fill('Verification-only note')
  await page.reload();await page.waitForSelector('.voice')
  assert.equal(await page.locator('#note').inputValue(),'Verification-only note')
  assert.equal(await page.locator('input[aria-label="Prefer voice A"]').isChecked(),true)
  await page.locator('#next').click();assert.match(await page.locator('#text').textContent(),/Zach/u)
  await page.locator('#reveal').click();assert.equal(await page.locator('.voice-name').filter({hasText:/Grok/u}).count(),1)
  const exportPath=join(dir,'qa-preferences.json')
  await app.evaluate(({app,session},path)=>{app.benchDownloadState='pending';session.defaultSession.once('will-download',(_event,item)=>{item.setSavePath(path);item.once('done',(_e,state)=>{app.benchDownloadState=state})})},exportPath)
  await page.locator('#export').click()
  for(let i=0;i<100&&(await app.evaluate(({app})=>app.benchDownloadState))==='pending';i++)await new Promise(r=>setTimeout(r,100))
  assert.equal(await app.evaluate(({app})=>app.benchDownloadState),'completed','Electron export download')
  const exported=JSON.parse(readFileSync(join(dir,'qa-preferences.json'),'utf8'));assert.equal(Object.keys(exported.votes).length,1)
  await page.evaluate(()=>{localStorage.clear()});await page.reload();await page.waitForSelector('.voice')
  const trials=readFileSync(join(dir,'trials.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x)).filter(r=>r.ok)
  const decoded=[]
  for(const r of trials){
    const audio=readFileSync(join(dir,r.audio)).toString('base64')
    const actual=await page.evaluate(async b64=>{const ctx=new AudioContext();const bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));const buffer=await ctx.decodeAudioData(bytes.buffer);await ctx.close();return {durationMs:buffer.duration*1000,channels:buffer.numberOfChannels}},audio)
    assert.ok(Math.abs(actual.durationMs-r.audioInfo.durationMs)<1,`${r.audio} duration`)
    decoded.push({file:r.audio,...actual})
    if(decoded.length%50===0)console.log(JSON.stringify({decoded:decoded.length,total:trials.length}))
  }
  // Real Chromium media playback, muted during automated QA; not speaker onset.
  await page.locator('#fixture').selectOption('6')
  await page.evaluate(()=>document.querySelectorAll('audio').forEach(a=>a.muted=true))
  await page.getByRole('button',{name:'Play voice A',exact:true}).click()
  await page.waitForFunction(()=>{const a=document.querySelector('audio');return !a.paused&&a.currentTime>0},undefined,{polling:50,timeout:5000})
  await page.getByRole('button',{name:'Play voice B',exact:true}).click()
  await page.waitForFunction(()=>{const a=[...document.querySelectorAll('audio')];return a[0].paused&&!a[1].paused&&a[1].currentTime>0},undefined,{polling:50,timeout:5000})
  await page.evaluate(()=>document.querySelectorAll('audio').forEach(a=>a.pause()))
  await page.screenshot({path:join(dir,'listening-desktop.png'),fullPage:true})
  await page.setViewportSize({width:390,height:844})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true)
  await page.screenshot({path:join(dir,'listening-mobile.png'),fullPage:true})
  await page.setViewportSize({width:760,height:1000})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true)
  await page.screenshot({path:join(dir,'listening-tablet.png'),fullPage:true})
  assert.deepEqual(errors,[])
  writeFileSync(join(dir,'verification.json'),JSON.stringify({electron:await app.evaluate(()=>process.versions.electron),decodedAudioFiles:decoded.length,decodeChecks:decoded,interactionChecks:['four voices','24 fixtures','preference persistence','fixture navigation','reveal voices','export JSON','real muted playback','one audio at a time','desktop/mobile/tablet screenshots','no horizontal overflow'],pageErrors:errors,acousticPlaybackMeasured:false},null,2))
  console.log(JSON.stringify({decodedAudioFiles:decoded.length,interactionChecks:'passed',pageErrors:errors}))
}finally{await app.close()}
