/* global console, process, URL */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { randomInt, randomUUID, createHash } from 'node:crypto'
import { percentile, normalizeWave, waveInfo } from './bench.mjs'

const dir=resolve(process.argv[2]||'')
const result=JSON.parse(readFileSync(join(dir,'summary.json'),'utf8'))
const rows=readFileSync(join(dir,'trials.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x))
// Repair streaming RIFF length markers in saved listening containers only.
// Preserve raw bytes and original checksums; no synthesis rerun is needed.
for(const row of rows.filter(r=>r.ok)) {
  const path=join(dir,row.audio), wav=readFileSync(path)
  if(wav.readUInt32LE(4)!==wav.length-8) {
    const normalized=normalizeWave(wav)
    row.originalWaveSha256=row.sha256
    row.sha256=createHash('sha256').update(normalized).digest('hex')
    row.normalization='Finalized PCM WAV container from streaming RIFF; raw response unchanged.'
    row.audioInfo=waveInfo(normalized)
    writeFileSync(path,normalized)
  }
}
writeFileSync(join(dir,'trials.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n')
const good=rows.filter(r=>r.ok&&r.phase!=='warmup')
const round=n=>n==null?null:Math.round(n)
const names={kokoro:'Kokoro · Heart',flux:'Flux · Haley',fish:'Fish · reference voice 1',grok:`Grok · ${result.manifest.grokVoice}`}
// Earliest idealized continuous playback start consistent with ALL captured
// chunk arrivals. Offline lower bound: no IPC, render quantum or device latency.
function continuousStart(row) {
  const bytesPerMs=row.audioInfo.rate*row.audioInfo.channels*2/1000
  const raw=readFileSync(join(dir,row.raw))
  const header=raw.toString('ascii',0,4)==='RIFF'?waveInfo(raw).offset:0
  let previous=0, earliest=0
  for(const arrival of row.arrivals) {
    if(arrival.bytes>header) earliest=Math.max(earliest,arrival.ms-Math.max(0,previous-header)/bytesPerMs)
    previous=arrival.bytes
  }
  return round(earliest)
}
const derived=result.summary.map(summary=>{
  const selected=good.filter(r=>r.model===summary.model&&r.voice===summary.voice)
  return {...summary,continuousStartP50Ms:percentile(selected.map(continuousStart),.5),continuousStartP95Ms:percentile(selected.map(continuousStart),.95),
    durationP50Ms:percentile(selected.map(r=>r.audioInfo.durationMs),.5),
    categories:[...new Set(selected.map(r=>r.category))].map(category=>{
      const subset=selected.filter(r=>r.category===category)
      return {category,n:subset.length,signalP50Ms:percentile(subset.map(r=>r.firstSignalAvailableMs),.5),completeP50Ms:percentile(subset.map(r=>r.completeMs),.5)}
    })}
})
writeFileSync(join(dir,'analysis.json'),JSON.stringify({summary:derived},null,2))
const heading='| Model / voice | Success | First audio data p50 / p95 | Full response p50 / p95 |\n| --- | --- | --- | --- |'
const table=derived.map(s=>`| ${names[s.model]} | ${s.successes}/${s.attempted} | ${round(s.firstByteP50Ms)} / ${round(s.firstByteP95Ms)} ms | ${round(s.completeP50Ms)} / ${round(s.completeP95Ms)} ms |`).join('\n')
const md=`# Sotto voice benchmark: first hosted screen\n\nRun: ${result.manifest.startedAt}. ${result.attemptedCalls} calls including warmups.\nConservative reserved cost: $${result.reservedUpperUsd.toFixed(4)} at researched tariffs; not an invoice.\n\n${heading}\n${table}\n\n24 fixed synthetic fixtures, three repetitions per model, serial requests with rotated model order.\nFour unscored warmups. OpenRouter PCM for Kokoro/Flux/Fish; production Grok service and saved ${result.manifest.grokVoice} voice for Grok.\nFish reference voice: ca3007f96ae7499ab87d27ea3599956a (official quickstart example).\n\nThese are service/network timings in Electron main, not audible speaker latency. Full-response timing excludes renderer IPC, decode and playback setup. First-byte timing can include silent PCM or a WAV header. See firstSignalAvailableMs in trials for the first non-silent PCM chunk. No provider-side cold/warm state is asserted.\n\n## Streaming analysis\n\n| Model | First signal chunk p50 / p95 | Ideal continuous start p50 / p95 |\n| --- | --- | --- |\n${derived.map(s=>`| ${names[s.model]} | ${round(s.firstSignalP50Ms)} / ${round(s.firstSignalP95Ms)} ms | ${s.continuousStartP50Ms} / ${s.continuousStartP95Ms} ms |`).join('\n')}\n\nIdeal continuous start is an offline lower bound computed from the entire captured arrival curve and audio sample rate. It is the earliest start that would avoid starving an ideal PCM player, without IPC, scheduling, decode or device overhead. It is not a streaming playback test. Sotto currently waits for a complete response.\n\n## Remaining selection gates\n\nUse listening.html for randomized, anonymized clips. Preference and pronunciation scores are not filled automatically. Three human listeners, actual output onset/stop capture, and macOS validation remain unverified. No product provider switch or streaming player was installed by this benchmark.\n\nPublic sample text and raw audio, hashes, response IDs, chunk timings and errors are retained locally. No keys or private dictation samples appear in results.\n`
writeFileSync(join(dir,'report.md'),md)
mkdirSync(join(dir,'blind'),{recursive:true})
const mapping={}, comparisons=[]
for(const fixture of result.manifest.fixtures) {
  const selected=good.filter(r=>r.fixtureId===fixture.id&&r.repeat===1)
  if(selected.length!==4) continue
  for(let i=selected.length-1;i>0;i--){const j=randomInt(i+1);[selected[i],selected[j]]=[selected[j],selected[i]]}
  const clips=selected.map((row,i)=>{
    const id=randomUUID(),path=`blind/${id}.wav`
    copyFileSync(join(dir,row.audio),join(dir,path))
    mapping[id]={model:row.model,voice:row.voice,source:row.audio}
    return {id,label:String.fromCharCode(65+i),path,name:names[row.model]}
  })
  comparisons.push({...fixture,clips})
}
writeFileSync(join(dir,'blind-mapping.json'),JSON.stringify(mapping,null,2))
const data={run:result.manifest.startedAt,comparisons,summary:derived,names}
writeFileSync(join(dir,'listening-data.json'),JSON.stringify(data,null,2))
const template=readFileSync(new URL('./listening.html',import.meta.url),'utf8')
writeFileSync(join(dir,'listening.html'),template.replace('/* BENCH_DATA */',`const bench = ${JSON.stringify(data).replace(/</gu,'\\u003c')};`))
console.log(JSON.stringify({report:join(dir,'report.md'),listening:join(dir,'listening.html'),comparisons:comparisons.length,summary:result.summary}))
