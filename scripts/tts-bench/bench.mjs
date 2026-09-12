/* global Buffer, console, process, URL, AbortController, AbortSignal, Response, TransformStream, fetch, setTimeout, clearTimeout */
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { cpus, platform, release } from 'node:os'
import { performance } from 'node:perf_hooks'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '../..')
const require = createRequire(import.meta.url)
const MAX_BYTES = 14 * 1024 * 1024
const round = n => n == null ? null : Math.round(n * 10) / 10
const hash = data => createHash('sha256').update(data).digest('hex')
export const percentile = (values, p) => values.length ? [...values].sort((a,b) => a-b)[Math.max(0, Math.ceil(values.length * p) - 1)] : null

export function pcmWave(pcm, rate, channels = 1) {
  if (!Number.isInteger(rate) || rate < 8000 || rate > 192000 || ![1,2].includes(channels) || !pcm.length || pcm.length % (2 * channels)) throw new Error('Invalid PCM format')
  const wav = Buffer.alloc(44 + pcm.length)
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ',8)
  wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(channels,22)
  wav.writeUInt32LE(rate,24); wav.writeUInt32LE(rate * channels * 2,28)
  wav.writeUInt16LE(channels * 2,32); wav.writeUInt16LE(16,34); wav.write('data',36)
  wav.writeUInt32LE(pcm.length,40); pcm.copy(wav,44)
  return wav
}

export function waveInfo(wav) {
  if (wav.toString('ascii',0,4) !== 'RIFF' || wav.toString('ascii',8,12) !== 'WAVE') throw new Error('Invalid wave header')
  let format, data
  for (let offset=12; offset+8 <= wav.length;) {
    const id=wav.toString('ascii',offset,offset+4), size=wav.readUInt32LE(offset+4), start=offset+8
    if (id === 'fmt ' && size >= 16 && start + 16 <= wav.length) format={encoding:wav.readUInt16LE(start),channels:wav.readUInt16LE(start+2),rate:wav.readUInt32LE(start+4),bits:wav.readUInt16LE(start+14)}
    if (id === 'data') { data={offset:start,bytes:Math.min(size,wav.length-start)}; break }
    offset=start+size+(size%2)
  }
  if (!format || !data || format.encoding !== 1 || format.bits !== 16 || ![1,2].includes(format.channels) || !format.rate || !data.bytes || data.bytes % (format.channels*2)) throw new Error('Unsupported wave audio')
  const samples=data.bytes/2
  let first=null, peak=0, squares=0
  // -50 dBFS crossing is an audio-signal marker, not acoustic audibility.
  for(let i=0;i<samples;i++) { const v=wav.readInt16LE(data.offset+i*2); peak=Math.max(peak,Math.abs(v)); squares+=v*v; if(first===null && Math.abs(v)>=104) first=i }
  return {...format,...data,durationMs:round(samples/format.channels/format.rate*1000),leadingSignalMs:first===null?null:round(Math.floor(first/format.channels)/format.rate*1000),firstSignalByte:first===null?null:data.offset+(first+1)*2,peak,rms:round(Math.sqrt(squares/samples))}
}

export function pcmFormat(contentType) {
  const rate=/(?:rate|sample_rate|samplerate)\s*=\s*"?(\d+)/iu.exec(contentType)
  const channels=/channels\s*=\s*"?(\d+)/iu.exec(contentType)
  if (!/^audio\/(?:pcm|l16)(?:;|$)/iu.test(contentType) || !rate) return null
  // L16 is network-endian and must not be treated as little-endian PCM.
  if (/^audio\/l16/iu.test(contentType)) return null
  return {rate:Number(rate[1]),channels:channels?Number(channels[1]):1}
}

export function normalizeWave(wav) {
  const info=waveInfo(wav)
  return pcmWave(wav.subarray(info.offset,info.offset+info.bytes),info.rate,info.channels)
}

function parseArgs(argv) {
  const args={mode:'smoke',runs:3,budget:1,only:null}
  for(let i=0;i<argv.length;i++) {
    const flag=argv[i], value=argv[++i]
    if(flag==='--mode' && ['smoke','screen','audition'].includes(value)) args.mode=value
    else if(flag==='--runs') args.runs=Number(value)
    else if(flag==='--budget') args.budget=Number(value)
    else if(flag==='--only') args.only=value.split(',')
    else throw new Error('Invalid benchmark argument')
  }
  if(!Number.isInteger(args.runs)||args.runs<1||args.runs>10||!Number.isFinite(args.budget)||args.budget<=0||args.budget>5) throw new Error('Invalid run or budget limit')
  return args
}

export async function run({getKey,grokVoice,argv}) {
  const args=parseArgs(argv)
  if(!grokVoice || /[\p{Cc}]/u.test(grokVoice)) throw new Error('Saved Grok voice missing')
  // Only the intended provider receives each credential.
  const keys={openrouter:getKey('formatting'),grok:getKey('grokSpeech')}
  if(!keys.openrouter || !keys.grok) throw new Error('Credential missing')
  const allFixtures=JSON.parse(readFileSync(join(HERE,'fixtures.json'),'utf8'))
  const candidates=[
    {id:'kokoro',model:'hexgrad/kokoro-82m',voice:'af_heart',route:'openrouter',usdPerMillion:4},
    {id:'flux',model:'deepgram/flux-tts:free',voice:'flux-haley-en',route:'openrouter',usdPerMillion:0},
    {id:'fish',model:'fish-audio/s2.1-pro',voice:'ca3007f96ae7499ab87d27ea3599956a',route:'openrouter',usdPerMillion:15},
    {id:'grok',model:'xai-direct-tts',voice:grokVoice,route:'grok',usdPerMillion:15},
  ].filter(c=>!args.only || args.only.includes(c.id))
  if(!candidates.length || args.only?.some(id=>!candidates.some(c=>c.id===id))) throw new Error('Unknown model selection')
  const fixtures=args.mode==='smoke'?[allFixtures.find(f=>f.id==='status-01')]:args.mode==='audition'?allFixtures.filter(f=>['status-01','names-01','numbers-02'].includes(f.id)):allFixtures
  const configs=args.mode==='audition'?candidates.flatMap(c=>c.id==='kokoro'?['af_heart','af_bella','am_michael'].map(voice=>({...c,voice})):c.id==='flux'?['flux-haley-en','flux-jack-en','flux-priya-en'].map(voice=>({...c,voice})):c.id==='fish'?[c,{...c,voice:'9a9cf47702da476aa4629e2506d4a857'}]:[c]):candidates
  const stamp=new Date().toISOString().replace(/[:.]/gu,'-')
  const output=join(ROOT,'artifacts/tts-bench',`${stamp}-${args.mode}`)
  mkdirSync(join(output,'audio'),{recursive:true})
  const jobs=[]
  if(args.mode==='screen') for(const c of configs) jobs.push({config:c,fixture:{id:'warmup',category:'warmup',text:'The voice benchmark is ready.'},repeat:0,phase:'warmup'})
  const repeats=args.mode==='screen'?args.runs:1
  for(let repeat=1;repeat<=repeats;repeat++) for(let i=0;i<fixtures.length;i++) {
    // Rotate order to avoid placing one service consistently first or last.
    for(let j=0;j<configs.length;j++) jobs.push({config:configs[(j+i+repeat-1)%configs.length],fixture:fixtures[i],repeat,phase:args.mode})
  }
  const estimated=jobs.reduce((v,j)=>v+Buffer.byteLength(j.fixture.text,'utf8')*j.config.usdPerMillion/1e6,0)
  const manifest={startedAt:new Date().toISOString(),args,grokVoice,configs,fixtures,fixtureHash:hash(JSON.stringify(fixtures)),plannedCalls:jobs.length,estimatedUpperUsd:estimated,budgetUsd:args.budget,
    runtime:{platform:platform(),release:release(),cpu:cpus()[0]?.model,node:process.versions.node,electron:process.versions.electron},
    measurements:{firstByte:'First nonempty response-body chunk at Electron main; includes network, not playback.',signalAvailable:'Arrival of the chunk containing the first PCM sample at or above -50 dBFS. Retrospective sample inspection; not audible output.',complete:'Full response body received, before final validation, IPC, decode or playback.',audio:'16-bit PCM WAVs; raw response and chunk timing retained.',repeats:'Reused process/network pool; not proof of provider warm model residency.',limits:'No acoustic loopback, macOS run, human preference scores or production streaming integration.'}}
  writeFileSync(join(output,'manifest.json'),JSON.stringify(manifest,null,2))
  console.log(JSON.stringify({event:'plan',output,calls:jobs.length,estimatedUpperUsd:estimated,budgetUsd:args.budget,voices:configs.map(c=>({id:c.id,voice:c.voice}))}))
  if(estimated>args.budget) throw new Error('Planned cost exceeds budget')
  let reserved=0
  const rows=[], disabled=new Set()
  const {GrokSpeechService}=require(join(ROOT,'artifacts/tts-bench/grok-service.cjs'))
  for(const job of jobs) {
    const {config,fixture,repeat,phase}=job
    if(disabled.has(config.id)) continue
    const cost=Buffer.byteLength(fixture.text,'utf8')*config.usdPerMillion/1e6
    if(reserved+cost>args.budget) break
    reserved+=cost // Failed/aborted requests count too. Never retry invisibly.
    const index=rows.length+1, name=`${String(index).padStart(3,'0')}-${config.id}-${fixture.id}-r${repeat}`
    const row={index,model:config.id,modelId:config.model,voice:config.voice,fixtureId:fixture.id,category:fixture.category,repeat,phase,estimatedUpperUsd:cost,startedAt:new Date().toISOString()}
    const chunks=[], arrivals=[]
    let contentType='', status=null, complete=null, start=performance.now(), responseHeaders={}
    const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),45000)
    try {
      const trackedFetch=async(url,init)=>{
        const response=await fetch(url,{...init,redirect:'error',signal:AbortSignal.any([controller.signal,...(init.signal?[init.signal]:[])])})
        status=response.status; contentType=response.headers.get('content-type')||''
        responseHeaders=Object.fromEntries(['content-type','x-generation-id','x-request-id','x-provider','x-openrouter-provider','server-timing'].map(k=>[k,response.headers.get(k)]).filter(([,v])=>v))
        row.headersMs=round(performance.now()-start)
        if(!response.ok) { await response.body?.cancel(); throw new Error(`HTTP_${status}`) }
        let bytes=0
        const transform=new TransformStream({transform(chunk,sink){
          bytes+=chunk.byteLength
          if(bytes>MAX_BYTES) throw new Error('Audio too large')
          chunks.push(Buffer.from(chunk));arrivals.push({ms:round(performance.now()-start),bytes})
          sink.enqueue(chunk)
        },flush(){complete=round(performance.now()-start)}})
        return new Response(response.body.pipeThrough(transform),{status:response.status,headers:response.headers})
      }
      let wav, raw
      if(config.route==='grok') {
        const service=new GrokSpeechService({credentials:{get:()=>keys.grok},fetchFn:trackedFetch})
        const result=await service.synthesize(fixture.text,config.voice)
        wav=Buffer.from(result.audioBase64,'base64');raw=Buffer.concat(chunks)
      } else {
        const response=await trackedFetch('https://openrouter.ai/api/v1/audio/speech',{method:'POST',headers:{Authorization:`Bearer ${keys.openrouter}`,'Content-Type':'application/json'},
          body:JSON.stringify({model:config.model,input:fixture.text,voice:config.voice,response_format:'pcm'})})
        raw=Buffer.from(await response.arrayBuffer())
        const pcm=pcmFormat(contentType)
        if(raw.toString('ascii',0,4)==='RIFF') wav=normalizeWave(raw)
        else if(pcm) wav=pcmWave(raw,pcm.rate,pcm.channels)
        else throw new Error('PCM_FORMAT_UNSPECIFIED')
      }
      const info=waveInfo(wav)
      if(info.firstSignalByte===null) throw new Error('SILENT_AUDIO')
      const rawOffset=raw.toString('ascii',0,4)==='RIFF'?waveInfo(raw).firstSignalByte:info.firstSignalByte-info.offset
      row.ok=true;row.status=status;row.contentType=contentType;row.responseHeaders=responseHeaders
      row.firstByteMs=arrivals[0]?.ms??null;row.firstSignalAvailableMs=arrivals.find(a=>a.bytes>=rawOffset)?.ms??null;row.completeMs=complete
      row.audioInfo=info;row.chunkCount=arrivals.length;row.arrivals=arrivals;row.sha256=hash(wav)
      row.audio=`audio/${name}.wav`;row.raw=`audio/${name}.raw`
      writeFileSync(join(output,row.audio),wav);writeFileSync(join(output,row.raw),raw)
    } catch {
      row.ok=false;row.status=status;row.contentType=contentType;row.elapsedMs=round(performance.now()-start)
      row.error=controller.signal.aborted?'TIMEOUT':status&&!([200,201].includes(status))?`HTTP_${status}`:'INVALID_OR_FAILED_AUDIO'
      // Persistent access/format errors should not generate 72 more paid failures.
      if([400,401,402,403,404,422].includes(status)||args.mode==='smoke'||(status===200&&!controller.signal.aborted)) disabled.add(config.id)
    } finally {clearTimeout(timer);controller.abort()}
    rows.push(row);appendFileSync(join(output,'trials.jsonl'),JSON.stringify(row)+'\n')
    console.log(JSON.stringify({event:'trial',index,total:jobs.length,model:row.model,voice:row.voice,fixture:row.fixtureId,ok:row.ok,error:row.error,firstByteMs:row.firstByteMs,completeMs:row.completeMs}))
  }
  const summary=configs.map(c=>{
    const selected=rows.filter(r=>r.model===c.id&&r.voice===c.voice&&r.phase!=='warmup'),good=selected.filter(r=>r.ok)
    return {model:c.id,voice:c.voice,successes:good.length,attempted:selected.length,
      firstByteP50Ms:percentile(good.map(r=>r.firstByteMs),.5),firstByteP95Ms:percentile(good.map(r=>r.firstByteMs),.95),
      firstSignalP50Ms:percentile(good.map(r=>r.firstSignalAvailableMs),.5),firstSignalP95Ms:percentile(good.map(r=>r.firstSignalAvailableMs),.95),
      completeP50Ms:percentile(good.map(r=>r.completeMs),.5),completeP95Ms:percentile(good.map(r=>r.completeMs),.95)}
  })
  writeFileSync(join(output,'summary.json'),JSON.stringify({manifest,attemptedCalls:rows.length,reservedUpperUsd:reserved,summary},null,2))
  console.log(JSON.stringify({event:'complete',output,reservedUpperUsd:reserved,summary}))
}
