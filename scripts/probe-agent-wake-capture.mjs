import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import ts from 'typescript'
import process from 'node:process'
import console from 'node:console'
const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const argument = flag => process.argv[process.argv.indexOf(flag) + 1]
if (!process.argv.includes('--model-directory') || !process.argv.includes('--fixtures-directory')) {
  throw Error('Usage: node scripts/probe-agent-wake-capture.mjs --model-directory <local model> --fixtures-directory <David/Zira WAV folder> [--negative|--minimal]')
}
const fixtures = path.resolve(argument('--fixtures-directory'))
const model = path.resolve(argument('--model-directory'))
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'sotto-wake-capture-repro-'))
let service
try {
  for (const name of ['wake','wakeWorker']) {
    const source=await fs.readFile(path.join(root,'src/main/agents',name+'.ts'),'utf8')
    await fs.writeFile(path.join(scratch,name+'.cjs'),ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)
  }
  const captureSource=await fs.readFile(path.join(root,'src/renderer/src/agents/voiceCapture.ts'),'utf8')
  await build({stdin:{contents:captureSource,loader:'ts',resolveDir:path.join(root,'src/renderer/src/agents')},bundle:true,platform:'node',format:'cjs',outfile:path.join(scratch,'capture.cjs'),logLevel:'silent'})
  const {BrowserVoiceCapture}=require(path.join(scratch,'capture.cjs'))
  const {AgentWakeService}=require(path.join(scratch,'wake.cjs'))
  const sherpa=require(path.join(root,'node_modules/sherpa-onnx'))
  service=new AgentWakeService(path.join(root,'node_modules/sherpa-onnx'),path.join(scratch,'wakeWorker.cjs'))
  await service.prepare(model)
  // Only browser microphone/context effects are replaced. Every 128-frame block
  // passes through production capture/resampling and the actual pinned detector.
  let callback, rate=16000
  const node=()=>({connect(n){return n},disconnect(){}})
  globalThis.document={baseURI:'file:///wake-replay/'}
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{async getUserMedia(){return {getTracks(){return [{stop(){}}]}}}}}})
  globalThis.AudioContext=class {sampleRate=rate;audioWorklet={async addModule(){}};destination=node();createGain(){return {...node(),gain:{value:0}}};createMediaStreamSource(){return node()};async close(){}}
  globalThis.AudioWorkletNode=class {port={set onmessage(value){callback=value}};connect(n){return n};disconnect(){}}
  let failed=0,total=0
  const negative=process.argv.includes('--negative')
  const names=negative ? [
    ...['embedded','name','soda','sofa','tomorrow'].flatMap(name=>['David','Zira'].map(voice=>`speech-negative-${name}-${voice}.wav`)),
    'speech-next.wav','speech-send.wav','speech-sendlong.wav','speech-zirasend.wav',
    ...['speech-short.wav','speech-technical.wav','speech-propernoun.wav'].map(name=>path.join(root,'scripts/asr-bench/fixtures',name)),
    'silence','noise','tone',
  ] : process.argv.includes('--minimal') ? ['speech-wakeonly.wav'] : ['speech-wakeonly.wav','speech-sotto.wav','speech-zirawake.wav','speech-wake.wav','speech-ziracommand.wav']
  for (const name of names) {
    let wave
    if(['silence','noise','tone'].includes(name)){
      let seed=173;const samples=Float32Array.from({length:5*16000},(_,i)=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return name==='silence'?0:name==='noise'?(seed/4294967296*2-1)*.03:Math.sin(i/16000*Math.PI*880)*.05})
      wave={samples,sampleRate:16000}
    }else {const file=path.isAbsolute(name)?name:path.join(fixtures,name);await fs.access(file);wave=sherpa.readWave(file);if(wave.sampleRate!==16000||wave.samples.length===0)throw Error('Invalid fixture '+file)}
    for (const scale of (process.argv.includes('--minimal') ? [.1] : [1,.7,.5,.3,.2,.1,.05])) for(const sampleRate of (process.argv.includes('--minimal') ? [16000] : [16000,48000])) {
      rate=sampleRate
      const clips=[]
      const capture=new BrowserVoiceCapture({onUtterance:audio=>clips.push(audio),onError:error=>{throw error}})
      await capture.start()
      const audio=new Float32Array(Math.ceil((wave.samples.length/16000+2)*rate))
      const start=Math.floor(.5*rate)
      for(let i=0;i<Math.floor(wave.samples.length*rate/16000);i++)audio[start+i]=wave.samples[Math.floor(i*16000/rate)]*scale
      for(let at=0;at<audio.length;at+=128)callback({data:audio.slice(at,at+128)})
      await capture.stop()
      const detections=[]
      for(const clip of clips) detections.push(await service.detect(clip))
      const combined=['speech-wake.wav','speech-ziracommand.wav'].includes(name)
      const pass=negative?detections.every(d=>!d.detected):(combined?clips.length>=1:clips.length===1)&&detections[0]?.detected===true&&detections.slice(1).every(d=>!d.detected)
      total++;if(!pass)failed++
      console.log(JSON.stringify({name,scale,sampleRate,captured:clips.map(a=>a.length/16000),detections,firstAttempt:pass?'PASS':'FAIL'}))
    }
  }
  console.log(JSON.stringify({total,failed})); if(failed)process.exitCode=1
} finally {
  service?.dispose()
  if(path.dirname(scratch)===path.resolve(os.tmpdir())&&path.basename(scratch).startsWith('sotto-wake-capture-repro-'))await fs.rm(scratch,{recursive:true,force:true})
}
