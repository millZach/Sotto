/* global console, process, URL */
import { createServer } from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { resolve, relative, extname, isAbsolute } from 'node:path'

const root=resolve(process.argv[2]),port=Number(process.argv[3]||5187)
createServer((req,res)=>{
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405).end();return}
  try{
    const path=resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname))
    const rel=relative(root,path)
    if(rel.startsWith('..')||isAbsolute(rel))throw new Error('Invalid path')
    const stat=statSync(path)
    if(!stat.isFile())throw new Error('Not a file')
    const type={'.html':'text/html; charset=utf-8','.wav':'audio/wav','.json':'application/json; charset=utf-8','.md':'text/plain; charset=utf-8'}[extname(path)]||'application/octet-stream'
    res.setHeader('Content-Type',type);res.setHeader('Cache-Control','no-store');res.setHeader('Accept-Ranges','bytes')
    const range=/^bytes=(\d+)-(\d*)$/u.exec(req.headers.range||'')
    const start=range?Number(range[1]):0,end=range&&range[2]?Number(range[2]):stat.size-1
    if(start>end||end>=stat.size){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`}).end();return}
    if(range)res.writeHead(206,{'Content-Length':end-start+1,'Content-Range':`bytes ${start}-${end}/${stat.size}`})
    else res.writeHead(200,{'Content-Length':stat.size})
    if(req.method==='HEAD')res.end();else createReadStream(path,{start,end}).pipe(res)
  }catch{res.writeHead(404).end('Not found')}
}).listen(port,'127.0.0.1',()=>console.log(`Voice bench: http://127.0.0.1:${port}/listening.html`))
