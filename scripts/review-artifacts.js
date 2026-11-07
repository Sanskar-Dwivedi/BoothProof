// Read-only loopback preview. Exposes only the named public demonstration artifacts.
import { createServer } from 'node:http';
import { createReadStream,statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const files=new Map([
  ['workspace-video-preview.html','text/html; charset=utf-8'],
  ['workspace-recovery-demo-simulated.webm','video/webm'],
  ['devnet-live-evidence-recap.webm','video/webm'],
  ['hackathon-one-take-devnet-replay.webm','video/webm'],
  ['devnet-direct-30-preparation.html','text/html; charset=utf-8']
]);
const server=createServer((request,response)=>{
  const name=request.url==='/'?'workspace-video-preview.html':request.url?.slice(1);
  if(!['127.0.0.1:4176','localhost:4176'].includes(request.headers.host)||!['GET','HEAD'].includes(request.method)||!files.has(name)) {
    response.writeHead(404).end();return;
  }
  const path=fileURLToPath(new URL('../output/playwright/'+name,import.meta.url));
  let size;try{size=statSync(path).size;}catch{response.writeHead(404).end();return;}
  const headers={'Content-Type':files.get(name),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes'};
  let start=0,end=size-1,status=200;
  if(request.headers.range) {
    const range=/^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
    if(!range||!Number.isSafeInteger(Number(range[1]))||Number(range[1])>=size||
      (range[2]&&(!Number.isSafeInteger(Number(range[2]))||Number(range[2])<Number(range[1])))) {
      response.writeHead(416,{'Content-Range':'bytes */'+size}).end();return;
    }
    start=Number(range[1]);end=range[2]?Math.min(Number(range[2]),size-1):size-1;status=206;
    headers['Content-Range']=`bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length']=end-start+1;response.writeHead(status,headers);
  if(request.method==='HEAD')response.end();else createReadStream(path,{start,end}).on('error',()=>response.destroy()).pipe(response);
});
server.listen(4176,'127.0.0.1',()=>console.log('Read-only artifacts · http://127.0.0.1:4176/'));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close());
