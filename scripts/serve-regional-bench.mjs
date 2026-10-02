import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createReadStream, statSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Local-only benchmark server. Roots must be scratch dry-run layouts, and
// the root forecast must be clearly marked synthetic when it is a fixture.
// Example: node scripts/serve-regional-bench.mjs --root /tmp/root-fixture
//   --arome /tmp/arome --icon /tmp/icon --out /tmp/regional-browser --port 8791
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
for (const key of ['--root', '--arome', '--icon', '--out']) {
  if (!args.get(key)) throw new Error(`Required: ${key} SCRATCH_DIRECTORY`);
}
const out = path.resolve(args.get('--out'));
mkdirSync(out, {recursive: true});
const roots = {root: path.resolve(args.get('--root')), arome: path.resolve(args.get('--arome')), icon: path.resolve(args.get('--icon'))};
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(args.get('--port') || 8791);

const entry = `import { TileForecastStore } from '${repo}/engine/src/forecast/tileStore.ts';
import { HttpTileTransport } from '${repo}/engine/src/forecast/httpTransport.ts';
const stores = new Map();
const start = Date.parse(new URLSearchParams(location.search).get('start') || '2026-10-02T12:00Z');
const end = start + 6 * 3600_000;
const points = [{lat:48.39,lon:-4.48},{lat:49.1,lon:-3},{lat:49.64,lon:-1.62}];
window.runBench = async function(layer='root') {
  const regional = layer!=='root';
  let state=stores.get(layer);
  if(!state){
    const root=new HttpTileTransport({baseUrl:'/root'});
    const source=new HttpTileTransport({baseUrl:layer==='weather-arome'?'/arome':'/icon'});
    const reads=[];
    const store=new TileForecastStore({regionalLayers:regional?[layer]:[],transport:{
      fetchLatest:()=>root.fetchLatest(),
      fetchRegionalLatest:()=>source.fetchRegionalLatest(),
      fetchManifest:id=>id.startsWith('weather-arome-')||id.startsWith('weather-icon-eu-')?source.fetchManifest(id):root.fetchManifest(id),
      fetchTile:async(id,p,o)=>{const t=id.startsWith('weather-arome-')||id.startsWith('weather-icon-eu-')?source:root;
        const bytes=await t.fetchTile(id,p,o);reads.push({id,path:p,bytes:bytes.length});return bytes;}
    }});
    state={store,reads};stores.set(layer,state);
  }
  state.reads.length=0;
  const t=performance.now();
  const read=await state.store.getHazardForecasts(points,start,end);
  const result={layer,elapsed_ms:Math.round(performance.now()-t),models:Object.keys(read?.byModel??{}),
    requests:state.reads.slice(),regional_bytes:state.reads.filter(r=>r.id.startsWith('weather-arome-')||r.id.startsWith('weather-icon-eu-')).reduce((n,r)=>n+r.bytes,0)};
  document.getElementById('result').textContent=JSON.stringify(result,null,2);
  return result;
};
`;
writeFileSync(`${out}/entry.js`, entry);
await build({entryPoints:[`${out}/entry.js`],bundle:true,platform:'browser',format:'iife',outfile:`${out}/bundle.js`});
writeFileSync(`${out}/index.html`, '<!doctype html><title>Regional tile browser verification</title><h1>Regional tile browser verification</h1><p>Local scratch data: synthetic root fixture and live attributed AROME / ICON-EU tiles.</p><button onclick="runBench()">Root only</button><button onclick="runBench(\'weather-arome\')">AROME</button><button onclick="runBench(\'weather-icon-eu\')">ICON-EU</button><pre id="result">Ready</pre><script src="/bundle.js"></script>');
const dirs = {root:roots.root,arome:roots.arome,icon:roots.icon};
const server=createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  const parts=url.pathname.split('/').filter(Boolean);
  const directory=dirs[parts[0]];
  const base=directory||out;
  const relative=directory?parts.slice(1).join('/'):parts.join('/')||'index.html';
  const file=path.resolve(base,relative);
  if(!file.startsWith(base+'/')){res.writeHead(403);res.end();return;}
  try{const stat=statSync(file);res.writeHead(200,{'Content-Length':stat.size,
    'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.json')?'application/json':file.endsWith('.html')?'text/html':'application/octet-stream',
    'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'});createReadStream(file).pipe(res);
  }catch{res.writeHead(404);res.end();}
});
server.listen(port,'127.0.0.1',()=>console.log(`Scratch benchmark ready at http://127.0.0.1:${port}`));
