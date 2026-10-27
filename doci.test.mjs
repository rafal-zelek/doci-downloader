import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cli from './doci.mjs';

const page = 'https://doci.pl/User/book+fabc';
const html = '<title>Book (epub) - dokument User - Pobierz z Doci.pl</title><button data-file-id="123"></button><div data-ext="epub"></div>';
function fixtureFetch({ broken = false } = {}) {
  return async input => {
    const url = String(input);
    if (url === page) return new Response(html);
    if (url.endsWith('payment_info')) return Response.json({ success: true, response: { download_data: { download_url: 'https://doci.pl/download/', time: 123 } } });
    if (broken) return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2])); }, pull(c) { c.error(new Error('transfer interrupted')); } }), { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="Book.epub"' } });
    return new Response('COMPLETE', { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="Book.epub"' } });
  };
}

test('existing explicit output skips all network and remains unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'doci-test-')); const original = globalThis.fetch;
  try {
    const path = join(dir, 'Book.epub'); await writeFile(path, 'EXISTING');
    globalThis.fetch = async () => { throw new Error('network must not be used'); };
    assert.equal(await cli.downloadFile(page, path), path);
    assert.equal(await readFile(path, 'utf8'), 'EXISTING');
  } finally { globalThis.fetch = original; await rm(dir, { recursive: true, force: true }); }
});


test('existing inferred filename needs no manifest and skips payment/transfer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'doci-test-')); const original = globalThis.fetch;
  try {
    await writeFile(join(dir, 'Book.epub'), 'EXISTING'); let calls = 0;
    globalThis.fetch = async input => { calls++; assert.equal(String(input), page); return new Response(html); };
    await cli.downloadFile(page, undefined, dir);
    assert.equal(calls, 1);
    assert.equal(await readFile(join(dir, 'Book.epub'), 'utf8'), 'EXISTING');
  } finally { globalThis.fetch = original; await rm(dir, { recursive: true, force: true }); }
});


test('interrupted transfer keeps stable part; retry replaces it and next run skips', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'doci-test-')); const original = globalThis.fetch;
  try {
    const path = join(dir, 'Book.epub'); globalThis.fetch = fixtureFetch({ broken: true });
    await assert.rejects(cli.downloadFile(page, path), /transfer interrupted/);
    assert((await stat(path + '.part')).isFile());
    await assert.rejects(stat(path), { code: 'ENOENT' });
    globalThis.fetch = fixtureFetch(); await cli.downloadFile(page, path);
    assert.equal(await readFile(path, 'utf8'), 'COMPLETE');
    await assert.rejects(stat(path + '.part'), { code: 'ENOENT' });
    globalThis.fetch = async () => { throw new Error('network must not be used'); };
    await cli.downloadFile(page, path);
  } finally { globalThis.fetch = original; await rm(dir, { recursive: true, force: true }); }
});


test('directory retries 500, records error and continues to next file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'doci-test-')); const original = globalThis.fetch; const exitCode = process.exitCode;
  try {
    let failedCalls = 0;
    globalThis.fetch = async input => {
      const url = String(input);
      if (url.includes('+ddir')) return new Response('<article><a href="/User/fail+fbad">Fail</a></article><article><a href="/User/book+fabc">Book</a></article>');
      if (url.includes('+fbad')) { failedCalls++; return new Response('', { status: 500 }); }
      return fixtureFetch()(input);
    };
    await cli.runDirectory(['https://doci.pl/User/folder+ddir', dir]);
    assert.equal(failedCalls, 3);
    assert.equal(await readFile(join(dir, 'Book.epub'), 'utf8'), 'COMPLETE');
    const state = JSON.parse(await readFile(join(dir, '.doci-downloads.json'), 'utf8'));
    assert(state.errors.bad); assert(state.completed.abc);
    assert.equal(process.exitCode, 1);
  } finally { globalThis.fetch = original; process.exitCode = exitCode; await rm(dir, { recursive: true, force: true }); }
});


test('concurrency defaults to 5, isolates sessions, preserves manifest; limit is exact', async () => {
  for (const flags of [[], ['--concurrency','2'], ['--limit','1']]) {
    const dir = await mkdtemp(join(tmpdir(), 'doci-pool-')); const original = globalThis.fetch;
    let active = 0, peak = 0, transfers = 0;
    try {
      globalThis.fetch = async (input, options = {}) => {
        const url = String(input);
        if (url.includes('+ddir')) return new Response(Array.from({length:7},(_,i)=>`<article><a href="/User/book+f${i+1}">Book ${i+1}</a></article>`).join(''));
        const file = url.match(/\+f(\d+)$/)?.[1];
        if (file) return new Response(`<title>Book ${file} (epub) - dokument User - Pobierz z Doci.pl</title><button data-file-id="${file}"></button>`, {headers:{'Set-Cookie':`test_session=${file}; Path=/`}});
        if (url.endsWith('payment_info')) {
          const id = JSON.parse(options.body).item_id;
          assert.match(options.headers.Cookie, new RegExp(`test_session=${id}(;|$)`));
          return Response.json({success:true,response:{download_data:{download_url:`https://doci.pl/download/`,time:id}}});
        }
        const id = url.split('/').at(-1); active++; transfers++; peak=Math.max(peak,active);
        await new Promise(r=>setTimeout(r,25)); active--;
        return new Response('DATA',{headers:{'Content-Disposition':`attachment; filename="Book ${id}.epub"`,'Content-Type':'application/octet-stream','Content-Length':'4'}});
      };
      await cli.runDirectory(['https://doci.pl/User/folder+ddir',dir,...flags]);
      const expected = flags.includes('--limit') ? 1 : 7;
      assert.equal(transfers,expected);
      assert.equal(peak,flags.includes('--limit') ? 1 : flags.includes('--concurrency') ? 2 : 5);
      const state=JSON.parse(await readFile(join(dir,'.doci-downloads.json'),'utf8'));
      assert.equal(Object.keys(state.completed).length,expected);
    } finally {globalThis.fetch=original;await rm(dir,{recursive:true,force:true});}
  }
});


test('tree aggregates descendants and counts existing files as done', () => {
  const root={name:'Ebooki',files:[],done:0,failed:0,children:[]};
  const child={name:'Ebooki 01',files:[1,2,3],done:2,failed:1,children:[],parent:root};
  root.children.push(child);
  const lines=cli.treeLines([root,child]);
  assert.match(lines[0],/Ebooki .*2\/3 \| zostało 1 \| błędy 1/);
  assert.match(lines[1],/^└── Ebooki 01/);
});


test('parallel duplicate filenames do not write into the same part simultaneously', async () => {
  const dir=await mkdtemp(join(tmpdir(),'doci-lock-')); const original=globalThis.fetch;
  try {
    globalThis.fetch=fixtureFetch();
    const paths=await Promise.all([cli.downloadFile(page,undefined,dir),cli.downloadFile(page,undefined,dir)]);
    assert.equal(paths[0],paths[1]);
    assert.equal(await readFile(paths[0],'utf8'),'COMPLETE');
    await assert.rejects(stat(paths[0]+'.part'),{code:'ENOENT'});
  } finally {globalThis.fetch=original;await rm(dir,{recursive:true,force:true});}
});


test('large HTML metadata skips before payment and leaves existing part untouched; flag disables', async () => {
  const dir=await mkdtemp(join(tmpdir(),'doci-size-'));const original=globalThis.fetch;
  try {
    const path=join(dir,'Book.epub');await writeFile(path+'.part','OLD PART');
    let payment=0;
    globalThis.fetch=async (url,opts)=>{
      if(String(url)===page)return new Response(html+'<div id="iframe2" data-size="100000000"></div>');
      if(String(url).endsWith('payment_info'))payment++;
      return fixtureFetch()(url,opts);
    };
    const result=await cli.downloadFile(page,path);
    assert.equal(result.skippedLarge,true);assert.equal(payment,0);
    assert.equal(await readFile(path+'.part','utf8'),'OLD PART');
    await cli.downloadFile(page,path,dir,{maxSizeMb:0});
    assert.equal(payment,1);assert.equal(await readFile(path,'utf8'),'COMPLETE');
  }finally{globalThis.fetch=original;await rm(dir,{recursive:true,force:true});}
});


test('large Content-Length cancels body without consuming it', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'doci-size-'));const original=globalThis.fetch;
 try{
  let canceled=false;
  globalThis.fetch=async (url,opts)=>{
   if(String(url).includes('/download/123/'))return new Response(new ReadableStream({start(c){setTimeout(()=>{if(!canceled)c.error(new Error('body must not be consumed'));},50);},cancel(){canceled=true;}}),{headers:{'Content-Length':String(50*1024*1024+1),'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="Book.epub"'}});
   return fixtureFetch()(url,opts);
  };
  const result=await cli.downloadFile(page,join(dir,'Book.epub'));
  assert.equal(result.skippedLarge,true);assert(canceled);
  await assert.rejects(stat(join(dir,'Book.epub')),{code:'ENOENT'});
 }finally{globalThis.fetch=original;await rm(dir,{recursive:true,force:true});}
});


test('size flag uses decimal MB, accepts fractions and zero; rejects invalid/old flag',()=>{
 assert.equal(cli.parseSizeFlag(['url']).maxSizeMb,50);
 assert.deepEqual(cli.parseSizeFlag(['url','--filter-max-size-mb','5']),{args:['url'],maxSizeMb:5});
 assert.equal(cli.parseSizeFlag(['--filter-max-size-mb=2.5','url']).maxSizeMb,2.5);
 assert.equal(cli.parseSizeFlag(['--filter-max-size-mb','0']).maxSizeMb,0);
 for(const args of [['--filter-max-size-mb'],['--filter-max-size-mb','-1'],['--filter-max-size-mb=abc'],['--skip-large=false']]) assert.throws(()=>cli.parseSizeFlag(args));
});


test('directory remembers large exclusions, frees worker and can override them',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'doci-size-dir-'));const original=globalThis.fetch;
 let largePages=0;
 try{
  globalThis.fetch=async(url,opts)=>{
   const text=String(url);
   if(text.includes('+ddir'))return new Response('<article><a href="/User/big+fbig">Big</a></article><article><a href="/User/book+fabc">Book</a></article>');
   if(text.includes('+fbig')){largePages++;return new Response(html.replace('Book','Big')+'<div data-size="100000000"></div>');}
   return fixtureFetch()(url,opts);
  };
  const args=['https://doci.pl/User/folder+ddir',dir,'--concurrency','1'];
  await cli.runDirectory(args);
  let state=JSON.parse(await readFile(join(dir,'.doci-downloads.json'),'utf8'));
  assert(state.skippedLarge.big);assert(state.completed.abc);assert(!state.errors.big);
  await cli.runDirectory(args);assert.equal(largePages,1);
  await cli.runDirectory([...args,'--filter-max-size-mb','0']);assert.equal(largePages,2);
  state=JSON.parse(await readFile(join(dir,'.doci-downloads.json'),'utf8'));
  assert(!state.skippedLarge.big);assert(state.completed.big);
 }finally{globalThis.fetch=original;await rm(dir,{recursive:true,force:true});}
});


test('directory scan uses concurrency N and continues after a folder fails three times',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'doci-scan-'));const original=globalThis.fetch;const originalExit=process.exitCode;
 let active=0,peak=0,bad=0;
 try{
  globalThis.fetch=async(url,opts)=>{
   const text=String(url);
   if(text.includes('+droot'))return new Response(['bad','one','two','three'].map(id=>`<article><a href="/User/${id}+d${id}">${id}</a></article>`).join(''));
   if(/\+d(bad|one|two|three)$/.test(text)){
    active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,20));active--;
    if(text.includes('+dbad')){bad++;return new Response('',{status:500});}
    return new Response('<article><a href="/User/book+fabc">Book</a></article>');
   }
   return fixtureFetch()(url,opts);
  };
  await cli.runDirectory(['https://doci.pl/User/root+droot',dir,'--recursive','--concurrency','3']);
  assert.equal(peak,3);assert.equal(bad,3);assert.equal(process.exitCode,1);
  for(const id of ['one','two','three'])assert.equal(await readFile(join(dir,id+'--'+id,'Book.epub'),'utf8'),'COMPLETE');
  const report=JSON.parse(await readFile(join(dir,'.doci-scan-errors.json'),'utf8'));
  assert.equal(report.errors.length,1);assert.match(report.errors[0].url,/\+dbad$/);
 }finally{globalThis.fetch=original;process.exitCode=originalExit;await rm(dir,{recursive:true,force:true});}
});


test('failed root scan is reported without throwing and next invocation clears report on recovery',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'doci-scan-root-'));const original=globalThis.fetch;const originalExit=process.exitCode;
 try{
  let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response('',{status:500});};
  const args=['https://doci.pl/User/root+droot',dir];
  await cli.runDirectory(args);assert.equal(calls,3);assert.equal(process.exitCode,1);
  assert.equal(JSON.parse(await readFile(join(dir,'.doci-scan-errors.json'),'utf8')).errors.length,1);
  process.exitCode=0;
  globalThis.fetch=async()=>new Response('<h5 class="dir-previous">Parent</h5>');
  await cli.runDirectory(args);
  assert.equal(JSON.parse(await readFile(join(dir,'.doci-scan-errors.json'),'utf8')).errors.length,0);
  assert.equal(process.exitCode,0);
 }finally{globalThis.fetch=original;process.exitCode=originalExit;await rm(dir,{recursive:true,force:true});}
});


test('single-file CLI treats output as directory and accepts directory flags', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'doci-cli-dir-'));const original=globalThis.fetch;
 try{
  globalThis.fetch=fixtureFetch();
  await cli.main([page,dir+'/','--recursive','--concurrency','50']);
  assert.equal(await readFile(join(dir,'Book.epub'),'utf8'),'COMPLETE');
  await cli.main([page,dir,'--concurrency','50']);
  assert.equal(await readFile(join(dir,'Book.epub'),'utf8'),'COMPLETE');
 }finally{globalThis.fetch=original;await rm(dir,{recursive:true,force:true});}
});


test('custom decimal MB threshold allows exact size and rejects a byte above; higher threshold rechecks',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'doci-mb-'));const original=globalThis.fetch;
 try{
  let bytes=2_500_001,payments=0;
  globalThis.fetch=async(url,opts)=>{
   if(String(url)===page)return new Response(html+`<div data-size="${bytes}"></div>`);
   if(String(url).endsWith('payment_info'))payments++;
   return fixtureFetch()(url,opts);
  };
  assert((await cli.downloadFile(page,join(dir,'above.epub'),dir,{maxSizeMb:2.5})).skippedLarge);
  assert.equal(payments,0);
  bytes=2_500_000;
  const path=await cli.downloadFile(page,join(dir,'exact.epub'),dir,{maxSizeMb:2.5});
  assert.equal(await readFile(path,'utf8'),'COMPLETE');assert.equal(payments,1);
 }finally{globalThis.fetch=original;await rm(dir,{recursive:true,force:true});}
});


test('interactive accepts URLs while downloading, shares concurrency and keeps waiting when idle',async()=>{
 const {PassThrough}=await import('node:stream');
 const dir=await mkdtemp(join(tmpdir(),'doci-interactive-'));const original=globalThis.fetch;const input=new PassThrough();const output=new PassThrough();let text='';output.on('data',c=>text+=c);
 let peak=0,active=0,downloads=0;
 try{
  globalThis.fetch=async(url,options={})=>{
   const value=String(url),id=value.match(/\+f(\d+)$/)?.[1];
   if(id)return new Response(`<title>Book ${id} (epub) - dokument User - Pobierz z Doci.pl</title><button data-file-id="${id}"></button><div data-size="8"></div>`);
   if(value.endsWith('payment_info'))return Response.json({success:true,response:{download_data:{download_url:'https://doci.pl/download/',time:JSON.parse(options.body).item_id}}});
   const n=value.split('/').at(-1);active++;peak=Math.max(peak,active);downloads++;
   await new Promise(r=>setTimeout(r,40));active--;
   return new Response('COMPLETE',{headers:{'Content-Disposition':`attachment; filename="Book ${n}.epub"`,'Content-Type':'application/octet-stream','Content-Length':'8'}});
  };
  const running=cli.main(['--interactive',dir,'--concurrency','2','--filter-max-size-mb','5'],{input,output});
  input.write('https://doci.pl/User/book+f1\n');
  for(let i=0;!downloads&&i<100;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(downloads,1);
  input.write('https://doci.pl/User/book+f2\nhttps://doci.pl/User/book+f3\n');
  for(let i=0;downloads<3&&i<100;i++)await new Promise(r=>setTimeout(r,5));
  await new Promise(r=>setTimeout(r,70));
  let finished=false;running.then(()=>finished=true);
  await new Promise(r=>setTimeout(r,10));assert.equal(finished,false);
  input.write('https://doci.pl/User/book+f4\n');input.end();
  await running;
  assert.equal(downloads,4);assert.equal(peak,2);
  for(const id of [1,2,3,4])assert.equal(await readFile(join(dir,`Book ${id}.epub`),'utf8'),'COMPLETE');
  assert.match(text,/URL/);
 }finally{input.destroy();globalThis.fetch=original;await rm(dir,{recursive:true,force:true});}
});

test('shared runtime applies global limit, deduplicates queued URLs and survives an invalid URL',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'doci-runtime-'));const original=globalThis.fetch;
 try{
  globalThis.fetch=async(url,options={})=>{
   const value=String(url),id=value.match(/\+f(\d+)$/)?.[1];
   if(id)return new Response(`<title>Book ${id} (epub) - dokument User - Pobierz z Doci.pl</title><button data-file-id="${id}"></button>`);
   if(value.endsWith('payment_info'))return Response.json({success:true,response:{download_data:{download_url:'https://doci.pl/download/',time:JSON.parse(options.body).item_id}}});
   await new Promise(r=>setTimeout(r,15));
   return new Response('COMPLETE',{headers:{'Content-Disposition':`attachment; filename="Book ${value.split('/').at(-1)}.epub"`,'Content-Type':'application/octet-stream'}});
  };
  const runtime=cli.createRuntime({concurrency:2,limit:3,maxSizeMb:5,output:dir});
  try{
   assert.throws(()=>runtime.enqueue('https://example.com/bad'));
   const first=runtime.enqueue('https://doci.pl/User/book+f1');
   assert.equal(runtime.enqueue('https://doci.pl/User/book+f1'),first);
   await Promise.all([first,...[2,3,4,5].map(id=>runtime.enqueue(`https://doci.pl/User/book+f${id}`))]);
   assert.equal(runtime.completed,3);
  }finally{runtime.stop();}
 }finally{globalThis.fetch=original;await rm(dir,{recursive:true,force:true});}
});

test('removed dry-run and format options are rejected',()=>{
 for(const flag of ['--dry-run','--filter-formats','--metadata-concurrency'])assert.throws(()=>cli.parseOptions([page,flag]));
});

test('directory jobs share the same pool and persist shared manifest without lost entries',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'doci-jobs-'));const original=globalThis.fetch;
 let active=0,peak=0;
 try{
  globalThis.fetch=async(url,options={})=>{
   const text=String(url),folder=text.match(/\+d(\d+)$/)?.[1],id=text.match(/\+f(\d+)$/)?.[1];
   if(folder){active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,10));active--;return new Response([1,2,3].map(i=>`<article><a href="/User/book+f${folder}${i}">Book ${folder}${i}</a></article>`).join(''));}
   if(id)return new Response(`<title>Book ${id} (epub) - dokument User - Pobierz z Doci.pl</title><button data-file-id="${id}"></button><div data-size="8"></div>`);
   if(text.endsWith('payment_info'))return Response.json({success:true,response:{download_data:{download_url:'https://doci.pl/download/',time:JSON.parse(options.body).item_id}}});
   const n=text.split('/').at(-1);active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,20));active--;
   return new Response('COMPLETE',{headers:{'Content-Disposition':`attachment; filename="Book ${n}.epub"`,'Content-Type':'application/octet-stream'}});
  };
  const runtime=cli.createRuntime({output:dir,concurrency:2,maxSizeMb:5});
  try{await Promise.all([runtime.enqueue('https://doci.pl/User/first+d1'),runtime.enqueue('https://doci.pl/User/second+d2')]);assert.equal(runtime.completed,6);}finally{runtime.stop();}
  assert.equal(peak,2);
  const state=JSON.parse(await readFile(join(dir,'.doci-downloads.json'),'utf8'));
  assert.equal(Object.keys(state.completed).length,6);
 }finally{globalThis.fetch=original;await rm(dir,{recursive:true,force:true});}
});

test('interactive process applies size filter to every URL and continues after invalid input',async()=>{
 const {PassThrough}=await import('node:stream');
 const dir=await mkdtemp(join(tmpdir(),'doci-interactive-size-'));const original=globalThis.fetch;
 const input=new PassThrough(),output=new PassThrough();let text='';output.on('data',chunk=>text+=chunk);
 try{
  let payment=0;
  globalThis.fetch=async(url,options={})=>{
   const value=String(url),id=value.match(/\+f(\d+)$/)?.[1];
   if(id)return new Response(`<title>Book ${id} (epub) - dokument User - Pobierz z Doci.pl</title><button data-file-id="${id}"></button><div data-size="${id==='1'?6_000_000:8}"></div>`);
   if(value.endsWith('payment_info')){payment++;return Response.json({success:true,response:{download_data:{download_url:'https://doci.pl/download/',time:2}}});}
   return new Response('COMPLETE',{headers:{'Content-Disposition':'attachment; filename="Book 2.epub"','Content-Type':'application/octet-stream'}});
  };
  const run=cli.main(['--interactive',dir,'--recursive','--filter-max-size-mb','5','--concurrency','100'],{input,output});
  input.end('not-a-url\nhttps://doci.pl/User/book+f1\nhttps://doci.pl/User/book+f2\n/exit\n');
  const result=await run;
  assert.equal(result.large,1);assert.equal(result.completed,1);assert.equal(payment,1);
  assert.match(text,/Nie dodano/);
  await assert.rejects(stat(join(dir,'Book 1.epub')),{code:'ENOENT'});
  assert.equal(await readFile(join(dir,'Book 2.epub'),'utf8'),'COMPLETE');
 }finally{input.destroy();globalThis.fetch=original;await rm(dir,{recursive:true,force:true});}
});

test('failed download job does not stop another job in shared queue',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'doci-job-error-'));const original=globalThis.fetch;const originalExit=process.exitCode;
 try{
  let failures=0;
  globalThis.fetch=async(url,options={})=>{
   const value=String(url);
   if(value.endsWith('+f1')){failures++;return new Response('',{status:500});}
   if(value.endsWith('+f2'))return new Response('<title>Book 2 (epub) - dokument User - Pobierz z Doci.pl</title><button data-file-id="2"></button>');
   if(value.endsWith('payment_info'))return Response.json({success:true,response:{download_data:{download_url:'https://doci.pl/download/',time:2}}});
   return new Response('COMPLETE',{headers:{'Content-Disposition':'attachment; filename="Book 2.epub"','Content-Type':'application/octet-stream'}});
  };
  const runtime=cli.createRuntime({output:dir,concurrency:1});
  try{
   await Promise.all([runtime.enqueue('https://doci.pl/User/book+f1'),runtime.enqueue('https://doci.pl/User/book+f2')]);
   assert.equal(failures,3);assert.equal(runtime.failed,1);assert.equal(runtime.completed,1);
   assert.equal(await readFile(join(dir,'Book 2.epub'),'utf8'),'COMPLETE');
  }finally{runtime.stop();}
 }finally{globalThis.fetch=original;process.exitCode=originalExit;await rm(dir,{recursive:true,force:true});}
});
