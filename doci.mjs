#!/usr/bin/env node
import { createWriteStream } from 'node:fs';
import { link, unlink, mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';

const DEFAULT_MAX_SIZE_MB = 50;

export function parseSizeFlag(input) {
  const args = []; let maxSizeMb = DEFAULT_MAX_SIZE_MB;
  for (let i = 0; i < input.length; i++) {
    const arg = input[i];
    if (arg === '--filter-max-size-mb' || arg.startsWith('--filter-max-size-mb=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : input[++i];
      if (value === undefined || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) throw new Error('--filter-max-size-mb wymaga liczby MB >= 0 (0 = bez limitu).');
      maxSizeMb = Number(value);
      if (!Number.isFinite(maxSizeMb) || maxSizeMb * 1_000_000 > Number.MAX_SAFE_INTEGER || (maxSizeMb > 0 && maxSizeMb < 0.000001)) throw new Error('Nieprawidłowy limit --filter-max-size-mb.');
    } else if (arg === '--max-size-mb' || arg.startsWith('--max-size-mb=')) {
      throw new Error('Użyj --filter-max-size-mb zamiast --max-size-mb.');
    } else if (arg === '--skip-large' || arg.startsWith('--skip-large=')) {
      throw new Error('Zamiast --skip-large użyj --filter-max-size-mb N (0 = bez limitu).');
    } else args.push(arg);
  }
  return { args, maxSizeMb };
}

function maxBytes(options) {
  const mb = options.maxSizeMb ?? DEFAULT_MAX_SIZE_MB;
  return mb === 0 ? Infinity : mb * 1_000_000;
}

export function fileMetadata(html) {
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const match = title.match(/^(.*?) \(([^()]+)\) - dokument /);
  const format = (html.match(/\bdata-ext\s*=\s*["']([\da-z]+)["']/i)?.[1] || match?.[2] || '').toLowerCase();
  const size = html.match(/\bdata-size\s*=\s*["'](\d+)["']/i)?.[1];
  const bytes = size === undefined ? undefined : Number(size);
  const name = match ? filename(`filename="${match[1].replaceAll('"','_')}.${format}"`, 'unknown') : undefined;
  return { format: format || undefined, bytes: Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined, name };
}

const cookies = new Map();
const prId = process.env.DOCI_PR_ID ?? '';
if (prId && !/^\d+$/.test(prId)) throw new Error('DOCI_PR_ID musi być ciągiem cyfr.');
if (prId) cookies.set('cookie_cookieaccess_pr_id', { value: prId, domain: 'doci.pl', path: '/' });

function allowed(url) {
  if (url.protocol !== 'https:' || (url.hostname !== 'doci.pl' && !url.hostname.endsWith('.doci.pl')) || url.username || url.password || url.port) {
    throw new Error('Dozwolone są wyłącznie adresy HTTPS w domenie doci.pl.');
  }
}

async function request(input, options = {}, jar = cookies) {
  let url = new URL(input);
  const redirectsSeen = new Set([url.href]);
  for (let redirects = 0; redirects <= 10; redirects++) {
    allowed(url);
    const cookie = [...jar.entries()].filter(([, c]) =>
      (url.hostname === c.domain || (!c.hostOnly && url.hostname.endsWith('.' + c.domain))) && url.pathname.startsWith(c.path)
    ).map(([name, c]) => `${name}=${c.value}`).join('; ');
    const response = await fetch(url, {
      ...options, redirect: 'manual', signal: options.signal || AbortSignal.timeout(300_000),
      headers: { 'User-Agent': 'doci-cli/1.0', ...options.headers, ...(cookie ? { Cookie: cookie } : {}) },
    });
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split(';');
      const index = pair.indexOf('=');
      if (index < 1) continue;
      const name = pair.slice(0, index).trim();
      const c = { value: pair.slice(index + 1), domain: url.hostname, hostOnly: true, path: '/' };
      let expired = false;
      for (const attribute of attributes) {
        const [key, ...rest] = attribute.trim().split('=');
        const value = rest.join('=');
        if (key.toLowerCase() === 'domain') { c.domain = value.replace(/^\./, '').toLowerCase(); c.hostOnly = false; }
        if (key.toLowerCase() === 'path') c.path = value;
        if (key.toLowerCase() === 'max-age' && Number(value) <= 0) expired = true;
        if (key.toLowerCase() === 'expires' && Date.parse(value) < Date.now()) expired = true;
      }
      if (url.hostname !== c.domain && !url.hostname.endsWith('.' + c.domain)) continue;
      if (expired) jar.delete(name); else jar.set(name, c);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Przekierowanie bez Location.');
      const next = new URL(decodeHeaderUtf8(location), url);
      if (redirectsSeen.has(next.href)) {
        const error = new Error(`Pętla przekierowań HTTP ${response.status}: ${next.hostname}${next.pathname}`);
        error.nonRetryable = true;
        throw error;
      }
      redirectsSeen.add(next.href);
      url = next;
      if (response.status === 303 || ([301, 302].includes(response.status) && options.method === 'POST')) options = {};
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      const error = new Error(`HTTP ${response.status}: ${url.hostname}${url.pathname.split('/').slice(0, 2).join('/')}`);
      error.status = response.status;
      const retryAfter = response.headers.get('retry-after');
      error.retryAfterMs = retryAfter ? (/^\d+$/.test(retryAfter) ? Number(retryAfter)*1000 : Math.max(0,Date.parse(retryAfter)-Date.now())) : 0;
      throw error;
    }
    return response;
  }
  throw new Error('Przekroczono limit przekierowań.');
}

function decodeHeaderUtf8(value) {
  if ([...value].every(char => char.charCodeAt(0) <= 255)) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value, 'latin1')); } catch {}
  }
  return value;
}

function errorDetail(error) {
  const cause = error.cause?.code || error.cause?.message;
  return cause ? `${error.message} (${cause})` : error.message;
}

function filename(disposition, id) {
  const extended = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  let name = disposition.match(/filename="([^"]+)"/i)?.[1] || disposition.match(/filename=([^;]+)/i)?.[1] || `doci-${id}`;
  if (extended) { try { name = decodeURIComponent(extended[1]); } catch {} }
  else if ([...name].every(char => char.charCodeAt(0) <= 255)) {
    // Doci wysyła także surowe UTF-8 w filename; fetch udostępnia bajty jako Latin-1.
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(name, 'latin1')); } catch {}
  }
  name = name.replace(/[\\/<>:"|?*\x00-\x1f\x7f]/g, '_').trim().replace(/^\.+$/, '_');
  return name || `doci-${id}`;
}

async function existingFile(path) {
  if (!path) return false;
  try { return (await stat(path)).isFile(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function skipExisting(path, log = console.log) {
  if (!await existingFile(path)) return false;
  log(`Pomijam istniejący: ${path}`);
  return true;
}

async function preparePart(path) {
  await mkdir(dirname(path), { recursive: true });
  try { await writeFile(path + '.part', '', { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(unit ? 2 : 0)} ${units[unit]}`;
}

export function progressText(received, total, index = 1, count = 1) {
  const known = Number.isFinite(total) && total > 0;
  const fraction = known ? Math.min(1, received / total) : 0;
  const filled = Math.floor(fraction * 24);
  const bar = known ? '#'.repeat(filled) + '-'.repeat(24 - filled) : '?'.repeat(24);
  return `Plik ${index}/${count} [${bar}] ${known ? `${Math.floor(fraction * 100)}% ` : ''}${formatBytes(received)} / ${known ? formatBytes(total) : '? (brak rozmiaru)'}`;
}

function transferProgress(total, options) {
  let received = 0, lastRender = 0;
  const render = (force = false) => {
    if (options.onProgress) { options.onProgress(received, total); return; }
    const now = Date.now();
    if (!force && (!process.stderr.isTTY || now - lastRender < 100)) return;
    lastRender = now;
    const line = progressText(received, total, options.index, options.total);
    process.stderr.write(process.stderr.isTTY ? `\r\x1b[2K${line}` : line + '\n');
  };
  render(true);
  const stream = new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      if (received > maxBytes(options)) {
        const error = new Error(`Przekroczono limit ${options.maxSizeMb ?? DEFAULT_MAX_SIZE_MB} MB podczas transferu.`);
        error.skippedLarge = true; error.bytes = received; callback(error); return;
      }
      render(); callback(null, chunk);
    },
  });
  return { stream, finish() { render(true); if (!options.onProgress && process.stderr.isTTY) process.stderr.write('\n'); } };
}

const outputLocks = new Map();
async function withOutputLock(path, operation) {
  const previous = outputLocks.get(path) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  outputLocks.set(path, current);
  await previous;
  try { return await operation(); }
  finally { release(); if (outputLocks.get(path) === current) outputLocks.delete(path); }
}

export async function downloadFile(input, outputFile, outputDirectory = process.cwd(), options = {}) {
  const page = new URL(input);
  allowed(page);
  const jar = new Map(cookies);
  const get = (url, init) => request(url, init, jar);
  const log = options.log || console.log;
  let predicted = outputFile ? resolve(outputFile) : undefined;
  if (predicted && await skipExisting(predicted, log)) { options.onSkipped?.(); return predicted; }
  const html = await (await get(page)).text();
  const metadata = fileMetadata(html);
  if (!predicted) {
    if (metadata.name) predicted = resolve(outputDirectory, metadata.name);
    if (predicted && await skipExisting(predicted, log)) { options.onSkipped?.(); return predicted; }
  }
  const skipLarge = bytes => {
    log(`Pomijam >${options.maxSizeMb ?? DEFAULT_MAX_SIZE_MB} MB: ${page.href} (${formatBytes(bytes)})`);
    return { skippedLarge: true, bytes };
  };
  if (metadata.bytes > maxBytes(options)) return skipLarge(metadata.bytes);
  if (predicted) await preparePart(predicted);
  const id = html.match(/\bdata-file-id\s*=\s*["']?(\d+)/i)?.[1];
  if (!id) throw new Error('Brak data-file-id w HTML. Sprawdź URL lub zmianę struktury strony.');
  log(`Plik ${id}: sprawdzam dostęp…`);
  const payment = await (await get('https://doci.pl/download/payment_info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', Origin: 'https://doci.pl', Referer: page.href },
    body: JSON.stringify({ item_id: Number(id), item_type: 1, code: '', download_from_dir: 0, file_id: Number(id), no_headers: 1, menu_visible: 0 }),
  })).json();
  const data = payment.response?.download_data;
  if (!payment.success || !data?.download_url || !Number.isInteger(data.time)) {
    throw new Error(`Brak zgody na pobranie. Sprawdź DOCI_PR_ID i jego ważność. ${String(payment.response?.info || '').replace(/<[^>]*>/g, '').slice(0, 400)}`);
  }
  const download = new URL(`${data.download_url.replace(/\/$/, '')}/${id}/${data.time}`);
  const response = await get(download);
  const type = response.headers.get('content-type') || '';
  const disposition = response.headers.get('content-disposition') || '';
  if (/text\/html|application\/json/i.test(type) || !response.body) {
    await response.body?.cancel();
    throw new Error(`Zamiast pliku otrzymano ${type || 'pustą odpowiedź'}.`);
  }
  const headerSize = Number(response.headers.get('content-length'));
  if (headerSize > maxBytes(options)) {
    await response.body.cancel();
    return skipLarge(headerSize);
  }
  const output = outputFile ? resolve(outputFile) : resolve(outputDirectory, filename(disposition, id));
  await mkdir(dirname(output), { recursive: true });
  return withOutputLock(output, async () => {
  if (await skipExisting(output, log)) {
    await response.body.cancel();
    options.onSkipped?.();
    return output;
  }
  const temporary = `${output}.part`;
  // Od nowa, nie append: bez walidacji Range/ETag nie wolno sklejać transferów.
  await preparePart(output);
  const length = response.headers.get('content-length');
  const totalBytes = length && !response.headers.get('content-encoding') ? Number(length) : NaN;
  const progress = transferProgress(totalBytes, options);
  try {
    await pipeline(Readable.fromWeb(response.body), progress.stream, createWriteStream(temporary, { flags: 'w' }));
  } catch (error) {
    if (error.skippedLarge) return skipLarge(error.bytes);
    throw error;
  } finally { progress.finish(); }
  try {
    await link(temporary, output); // Atomowo publikuje wyłącznie ukończony transfer.
  } catch (error) {
    if (error.code !== 'EEXIST' || !await existingFile(output)) throw error;
  }
  await unlink(temporary).catch(() => {});
  if (predicted && predicted !== output) await unlink(predicted + '.part').catch(() => {});
  log(`Zapisano: ${output}`);
  return output;
  });
}

function decode(value) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, entity => {
    const names = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
    if (names[entity.toLowerCase()]) return names[entity.toLowerCase()];
    const code = entity.toLowerCase().startsWith('&#x') ? parseInt(entity.slice(3), 16) : parseInt(entity.slice(2), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '_';
  });
}

function directoryUrl(input) {
  const url = new URL(input);
  if (url.origin !== 'https://doci.pl' || url.username || url.password || !/\+d[\da-z]+$/i.test(url.pathname)) {
    throw new Error('Podaj URL katalogu https://doci.pl/USER/NAZWA+dID.');
  }
  url.hash = ''; url.search = '';
  return url;
}

function safeName(value) {
  return value.normalize('NFC').replace(/[\\/<>:"|?*\x00-\x1f\x7f]/g, '_').replace(/^\.+$/, '_').trim().slice(0, 160) || 'katalog';
}

export function parseDirectory(html, input) {
  const base = directoryUrl(input);
  const clean = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  if (!/class=["'][^"']*dir-previous\b/i.test(clean) && !/<article\b/i.test(clean)) {
    throw new Error('Nie rozpoznano listy katalogu; możliwy błąd strony lub zmiana HTML.');
  }
  if (/<(?:a|link)\b[^>]*rel=["']next["']/i.test(clean)) {
    throw new Error('Wykryto paginację: ten format wymaga sprawdzenia przed pobraniem całego katalogu.');
  }
  const entries = new Map();
  for (const article of clean.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/gi)) {
    for (const anchor of article[0].matchAll(/<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
      const url = new URL(decode(anchor[2]), base);
      if (url.origin !== base.origin || url.pathname.split('/')[1] !== base.pathname.split('/')[1]) continue;
      const match = url.pathname.match(/\+([fd])([\da-z]+)$/i);
      if (!match) continue;
      url.search = ''; url.hash = '';
      const name = decode(anchor[3].replace(/<[^>]*>/g, '')).trim();
      entries.set(`${match[1]}${match[2]}`, { kind: match[1] === 'd' ? 'directory' : 'file', id: match[2], url: url.href, name });
    }
  }
  return [...entries.values()];
}

async function readState(path) {
  try {
    const state = JSON.parse(await readFile(path, 'utf8'));
    if (state.version !== 1 || !state.completed || typeof state.completed !== 'object' || Array.isArray(state.completed)) throw new Error('Nieznany format');
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, completed: {} };
    throw new Error(`Nie można odczytać ${path}: ${error.message}`);
  }
}


async function retry(operation, label, log = console.error) {
  for (let attempt = 1; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= 3 || error.nonRetryable) throw error;
      log(`${label}: próba ${attempt}/3 nieudana: ${errorDetail(error)}; ponawiam…`);
      await new Promise(resolve => setTimeout(resolve, attempt * 1000));
    }
  }
}

async function saveState(path, state) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2) + '\n');
  await rename(temporary, path);
}

export function treeLines(nodes) {
  function totals(node) {
    const result = { total: node.files.length, done: node.done, failed: node.failed, large: node.large || 0, scanErrors: node.scanError ? 1 : 0 };
    for (const child of node.children) {
      const t = totals(child); result.total += t.total; result.done += t.done; result.failed += t.failed; result.large += t.large; result.scanErrors += t.scanErrors;
    }
    return result;
  }
  const lines = [];
  function visit(node, prefix, branch, childPrefix) {
    const t = totals(node);
    const ratio = t.total ? (t.done + t.large) / t.total : t.scanErrors ? 0 : 1;
    const filled = Math.floor(ratio * 16);
    lines.push(`${prefix}${branch}${node.name} [${'#'.repeat(filled)}${'-'.repeat(16-filled)}] ${t.done}/${t.total} | zostało ${t.total-t.done-t.large} | błędy ${t.failed}${t.large ? ` | ponad limit ${t.large}` : ''}${t.scanErrors ? ` | NIEPEŁNE: błędy listowania ${t.scanErrors}${node.scanError ? ' (zawartość nieznana)' : ''}` : ''}`);
    node.children.forEach((child, i) => {
      const last = i === node.children.length - 1;
      visit(child, prefix + childPrefix, last ? '└── ' : '├── ', last ? '    ' : '│   ');
    });
  }
  nodes.filter(node => !node.parent).forEach(node => visit(node, '', '', ''));
  return lines;
}

function dashboard(nodes, config = {}) {
  const output = config.output || process.stderr;
  const tty = !!output.isTTY;
  const messages = [];
  let closed = false, timer, lastFrame;
  const clean = text => String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
  const ui = {
    active: new Map(), input: null,
    log(message) {
      const text = clean(message);
      messages.push(text); if (messages.length > 3) messages.shift();
      if (!tty) output.write(text + '\n');
    },
    render() {
      if (!tty || closed) return;
      const width = Math.max(20, (output.columns || 100)-1);
      const rows = Math.max(5, (output.rows || 30)-1);
      const transfers = [...ui.active.values()].flatMap(item => [item.name, item.text]);
      const tree = treeLines(nodes);
      const treeBudget = Math.max(1, rows-Math.min(transfers.length, Math.floor(rows/2))-5);
      const visible = tree.length > treeBudget ? [...tree.slice(0, Math.max(0,treeBudget-1)), `… ${tree.length-treeBudget+1} dalszych katalogów`] : tree;
      const content = [...visible, '', ...transfers, '', ...messages];
      const lines = content.slice(0,rows-(config.interactive ? 2 : 0));
      if (config.interactive) {
        lines.push(ui.active.size ? `Aktywne transfery: ${ui.active.size}` : 'Czekam na kolejne URL-e. /exit kończy po opróżnieniu kolejki.');
        lines.push(`URL> ${ui.input?.line || ''}`);
      }
      const frame=lines.map(line=>Array.from(clean(line)).slice(0,width).join('')).join('\n');
      const cursor=config.interactive ? `\x1b[${lines.length};${Math.min(width,6+(ui.input?.cursor || 0))}H` : '';
      if(frame+cursor===lastFrame)return;
      lastFrame=frame+cursor;
      output.write('\x1b[H\x1b[J'+frame+cursor);
    },
    stop() {
      if (closed) return;
      closed = true; clearInterval(timer);
      process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate);
      if (tty) output.write('\x1b[?25h\x1b[?1049l');
      const lines = treeLines(nodes);
      if (lines.length) output.write(lines.join('\n')+'\n');
    },
  };
  const onInterrupt = () => {ui.stop();process.exit(130);};
  const onTerminate = () => {ui.stop();process.exit(143);};
  if (tty) {
    process.once('SIGINT',onInterrupt);process.once('SIGTERM',onTerminate);
    output.write('\x1b[?1049h'+(config.interactive ? '\x1b[?25h' : '\x1b[?25l'));
    timer=setInterval(()=>ui.render(),100);ui.render();
  }
  return ui;
}

export function createPool(concurrency) {
  let active=0;
  const waiting=[];
  function pump() {
    while(active<concurrency && waiting.length) {
      const {operation,resolve,reject}=waiting.shift(); active++;
      Promise.resolve().then(operation).then(resolve,reject).finally(()=>{active--;pump();});
    }
  }
  return {run(operation){return new Promise((resolve,reject)=>{waiting.push({operation,resolve,reject});pump();});}};
}

export function parseOptions(inputArgs) {
  const {args,maxSizeMb}=parseSizeFlag(inputArgs);
  const options={maxSizeMb,concurrency:5,limit:Infinity,recursive:false,list:false,interactive:false};
  const positional=[];
  for(let i=0;i<args.length;i++) {
    const arg=args[i];
    if(arg==='--help') options.help=true;
    else if(arg==='--interactive') options.interactive=true;
    else if(arg==='--recursive') options.recursive=true;
    else if(arg==='--list') options.list=true;
    else if(['--concurrency','--limit'].includes(arg)) {
      const value=Number(args[++i]);
      if(!Number.isSafeInteger(value)||value<1)throw new Error(`${arg} wymaga dodatniej liczby całkowitej.`);
      options[arg==='--limit'?'limit':'concurrency']=value;
    } else if(arg.startsWith('--')) throw new Error(`Nieznana opcja: ${arg}`);
    else positional.push(arg);
  }
  if(options.help)return options;
  if(options.interactive) {
    if(positional.length>1 || positional[0]?.startsWith('https://'))throw new Error('Tryb interactive: node doci.mjs --interactive [katalog docelowy] [opcje]. URL-e wpisuj po uruchomieniu.');
    options.output=resolve(positional[0]||process.cwd());
  } else {
    if(positional.length<1 || positional.length>2)throw new Error('Użycie: node doci.mjs URL [katalog docelowy] [opcje] albo --interactive [katalog docelowy] [opcje].');
    options.page=detectPage(positional[0]);
    options.output=positional[1] ? resolve(positional[1]) : undefined;
  }
  return options;
}

export function createRuntime(options = {}, io = {}) {
  const settings={concurrency:5,limit:Infinity,maxSizeMb:50,...options};
  const nodes=[];
  const display=dashboard(nodes,{interactive:settings.interactive,output:io.output});
  const pool=createPool(settings.concurrency);
  const stores=new Map(),pending=new Set(),duplicates=new Map(),budgetWaiters=[];
  let reserved=0,sequence=0;
  const runtime={...settings,nodes,display,pool,pending,completed:0,skipped:0,large:0,failed:0};
  runtime.log=message=>display.log(message);
  runtime.stop=()=>display.stop();
  runtime.drain=async()=>{while(pending.size)await Promise.allSettled([...pending]);};
  async function claim() {
    while(runtime.completed+reserved>=runtime.limit) {
      if(runtime.completed>=runtime.limit)return false;
      await new Promise(resolve=>budgetWaiters.push(resolve));
    }
    reserved++;return true;
  }
  function release(){reserved--;for(const resolve of budgetWaiters.splice(0))resolve();}
  runtime.store=path=>{
    if(!stores.has(path))stores.set(path,readState(path).then(state=>({state,saving:Promise.resolve()})));
    return stores.get(path);
  };
  runtime.persist=(path,store)=>{
    store.saving=store.saving.then(()=>saveState(path,store.state));return store.saving;
  };
  runtime.file=(file,destination,node,index,total,job)=>pool.run(async()=>{
    if(!await claim())return;
    const key=`${job}:${index}`;
    display.active.set(key,{name:`[job ${job}] ${file.name || file.url}`,text:`Plik ${index}/${total}: sprawdzam dostęp…`});
    try {
      await mkdir(destination,{recursive:true});
      const statePath=join(destination,'.doci-downloads.json');
      const store=await runtime.store(statePath),state=store.state;
      state.errors ||= {};state.skippedLarge ||= {};
      const previous=state.completed[file.id];
      if(previous?.path && dirname(resolve(previous.path))===destination && await existingFile(previous.path)) {
        node.done++;runtime.skipped++;return;
      }
      if(state.skippedLarge[file.id]?.bytes>maxBytes(runtime)) {node.large++;runtime.large++;return;}
      try {
        let skipped=false;
        const path=await retry(()=>downloadFile(file.url,undefined,destination,{
          maxSizeMb:runtime.maxSizeMb,index,total,
          log:runtime.log,onSkipped:()=>{skipped=true;},
          onProgress:(received,bytes)=>display.active.set(key,{name:`[job ${job}] ${file.name || file.url}`,text:progressText(received,bytes,index,total)}),
        }),file.name||file.url,runtime.log);
        if(path?.skippedLarge) {
          node.large++;runtime.large++;
          state.skippedLarge[file.id]={url:file.url,bytes:path.bytes,time:new Date().toISOString()};
          delete state.errors[file.id];
        } else {
          state.completed[file.id]={url:file.url,path,bytes:(await stat(path)).size};
          delete state.errors[file.id];delete state.skippedLarge[file.id];
          node.done++;if(skipped)runtime.skipped++;else runtime.completed++;
        }
      } catch(error) {
        node.failed++;runtime.failed++;process.exitCode=1;
        state.errors[file.id]={url:file.url,error:errorDetail(error),time:new Date().toISOString()};
        runtime.log(`Nie pobrano: ${file.url}: ${errorDetail(error)}. Kontynuuję kolejkę.`);
      }
      await runtime.persist(statePath,store);
    } finally {display.active.delete(key);release();}
  });
  runtime.enqueue=input=>{
    const page=detectPage(input.trim());
    const key=page.url;
    if(duplicates.has(key)){runtime.log(`Już w kolejce: ${key}`);return duplicates.get(key);}
    const job=++sequence;
    runtime.log(`[job ${job}] Dodano: ${page.url}`);
    const promise=Promise.resolve().then(async()=>{
      if(runtime.completed>=runtime.limit){runtime.log(`[job ${job}] Osiągnięto limit procesu ${runtime.limit}.`);return;}
      if(page.kind==='d')return runDirectoryJob(page,runtime,job);
      const destination=runtime.output||process.cwd();
      if(runtime.list){runtime.log(`${destination}\t${page.url}`);return;}
      return runtime.file({id:page.url.split('+f').at(-1),url:page.url},destination,{done:0,large:0,failed:0},1,1,job);
    }).catch(error=>{process.exitCode=1;runtime.log(`[job ${job}] Błąd: ${errorDetail(error)}. Pozostałe joby działają dalej.`);return {error:error.message};});
    duplicates.set(key,promise);pending.add(promise);
    promise.then(()=>{duplicates.delete(key);pending.delete(promise);runtime.log(`[job ${job}] Zakończono.`);});
    return promise;
  };
  return runtime;
}

async function runDirectoryJob(page,runtime,job) {
  const root=directoryUrl(page.url);
  const output=runtime.output||resolve(safeName(decodeURIComponent(root.pathname.split('/').pop())));
  const queue=[],visited=new Set(),plan=[],scanErrors=[];
  let order=0;
  function enqueue(dir){const id=dir.url.split('+d').at(-1);if(!visited.has(id)){visited.add(id);queue.push({...dir,order:order++});}}
  enqueue({url:root.href,path:output});
  async function scan(dir){
    let files=[],scanError;
    try {
      const entries=await retry(async()=>{
        const response=await request(dir.url,{signal:AbortSignal.timeout(60_000)},new Map(cookies));
        return parseDirectory(await response.text(),dir.url);
      },`Listowanie ${dir.url}`,runtime.log);
      files=entries.filter(entry=>entry.kind==='file');
      const children=entries.filter(entry=>entry.kind==='directory');
      runtime.log(`[job ${job}] Katalog ${dir.url}: ${files.length} plików, ${children.length} podkatalogów`);
      if(runtime.recursive)for(const child of children)enqueue({url:child.url,path:join(dir.path,`${safeName(child.name)}--${child.id}`)});
      if(runtime.list)for(const file of files)runtime.log(`${dir.path}\t${file.url}\t${file.name}`);
    } catch(error){scanError=errorDetail(error);scanErrors.push({url:dir.url,path:dir.path,error:scanError,time:new Date().toISOString()});process.exitCode=1;runtime.log(`Nie zlistowano ${dir.url}: ${scanError}. Kontynuuję.`);}
    plan.push({dir,files,scanError,done:0,large:0,failed:0,children:[]});
  }
  const scanning=new Set();
  while(queue.length||scanning.size){
    while(queue.length&&scanning.size<runtime.concurrency){
      const dir=queue.shift(),operation=runtime.pool.run(()=>scan(dir));
      scanning.add(operation);operation.then(()=>scanning.delete(operation),()=>scanning.delete(operation));
    }
    if(scanning.size)await Promise.race(scanning);
  }
  plan.sort((a,b)=>a.dir.order-b.dir.order);
  if(runtime.list)return;
  await mkdir(output,{recursive:true});
  const reportPath=join(output,'.doci-scan-errors.json');
  await withOutputLock(reportPath,async()=>{
    let report={version:1,roots:[],errors:[]};
    try{report=JSON.parse(await readFile(reportPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    const other=(report.errors||[]).filter(error=>error.root!==root.href && (error.root||report.root)!==root.href);
    await saveState(reportPath,{version:1,root:root.href,roots:[...new Set([...(report.roots||[]),root.href])],errors:[...other,...scanErrors.map(error=>({...error,root:root.href}))]});
  });
  const found=plan.reduce((sum,node)=>sum+node.files.length,0);
  const tasks=[];
  let fileIndex=0;
  for(const node of plan){
    node.name=decodeURIComponent(node.dir.url.split('/').pop().split('+d')[0]);
    node.parent=plan.find(parent=>parent.dir.path===dirname(node.dir.path));node.parent?.children.push(node);
    if(!node.parent)node.name=`[job ${job}] ${node.name}`;
    if(node.scanError)continue;
    await mkdir(node.dir.path,{recursive:true});
    const store=await runtime.store(join(node.dir.path,'.doci-downloads.json'));
    for(const file of node.files){
      const index=++fileIndex;
      const previous=store.state.completed[file.id];
      if(previous?.path&&dirname(resolve(previous.path))===node.dir.path&&await existingFile(previous.path)){node.done++;runtime.skipped++;continue;}
      if(store.state.skippedLarge?.[file.id]?.bytes>maxBytes(runtime)){node.large++;runtime.large++;continue;}
      tasks.push({file,node,index});
    }
  }
  runtime.nodes.push(...plan);
  runtime.log(`[job ${job}] Łącznie ${found} plików; do sprawdzenia ${tasks.length}. Wspólna pula: ${runtime.concurrency}.`);
  const results=await Promise.allSettled(tasks.map(({file,node,index})=>runtime.file(file,node.dir.path,node,index,found,job)));
  const rejected=results.find(result=>result.status==='rejected');
  if(rejected)throw rejected.reason;
  runtime.log(`[job ${job}] Katalogi: ${plan.length}; błędy listowania: ${scanErrors.length}.`);
}

export function detectPage(input) {
  const url=new URL(input);allowed(url);
  if(url.hostname!=='doci.pl')throw new Error('Podaj stronę pliku albo katalogu na doci.pl.');
  const kind=url.pathname.replace(/\/$/,'').match(/\+([fd])[\da-z]+$/i)?.[1]?.toLowerCase();
  if(!kind)throw new Error('Nie rozpoznano URL: oczekiwano +fID albo +dID.');
  url.pathname=url.pathname.replace(/\/$/,'');url.hash='';url.search='';
  return {kind,url:url.href};
}

export async function runDirectory(args) {
  const options=parseOptions(args);
  if(options.page.kind!=='d')throw new Error('Oczekiwano URL katalogu.');
  const runtime=createRuntime(options);
  try {return await runtime.enqueue(options.page.url);}finally{runtime.stop();}
}

async function interactive(options,io) {
  const input=io.input||process.stdin,output=io.output||process.stderr;
  const runtime=createRuntime(options,{output});
  const rl=createInterface({input,output,terminal:!!input.isTTY&&!!output.isTTY,prompt:'URL> '});
  runtime.display.input=rl;
  runtime.log(`Interactive: wklejaj URL-e (Enter dodaje). Wspólna concurrency ${options.concurrency}, limit rozmiaru ${options.maxSizeMb} MB. /exit lub Ctrl-D: opróżnij kolejkę i zakończ.`);
  const interrupt=()=>{runtime.stop();rl.close();process.exit(130);};
  rl.on('SIGINT',interrupt);
  try {
    for await(const line of rl){
      const text=line.trim();
      if(['/exit','/quit'].includes(text)){rl.close();break;}
      if(text==='/status'){runtime.log(`Joby: ${runtime.pending.size}; pobrano ${runtime.completed}; pominięto ${runtime.skipped}; ponad limit ${runtime.large}; błędy ${runtime.failed}.`);continue;}
      for(const token of text.split(/\s+/).filter(Boolean)){
        try{runtime.enqueue(token.replace(/^['"]|['"]$/g,''));}
        catch(error){runtime.log(`Nie dodano: ${error.message}`);}
      }
      runtime.display.render();
    }
    runtime.log('Koniec inputu — czekam na zakończenie kolejki…');
    await runtime.drain();
    return {completed:runtime.completed,skipped:runtime.skipped,large:runtime.large,failed:runtime.failed};
  }finally{rl.off('SIGINT',interrupt);rl.close();runtime.stop();}
}

export async function main(args=process.argv.slice(2),io={}) {
  if(!args.length||args.includes('--help')){
    (io.output||process.stdout).write(`node doci.mjs URL [katalog docelowy] [opcje]\nnode doci.mjs --interactive [katalog docelowy] [opcje]\n--recursive; --concurrency N (domyślnie 5, wspólna pula procesu); --limit N (nowe pliki w procesie)\n--filter-max-size-mb N (domyślnie 50; 0=bez limitu; 1 MB=1 000 000 B)\n--list: tylko listowanie. Interactive: URL + Enter; /status; /exit lub Ctrl-D opróżnia kolejkę.\nDOCI_PR_ID: własny numer akcji PRowej, bez wartości domyślnej. Odczytaj go ze swojej przeglądarki tylko jeśli otrzymałeś uprawnienie do tej akcji. Node.js 22+.\n`);
    if(!args.length)process.exitCode=1;
    return;
  }
  const options=parseOptions(args);
  if(options.interactive)return interactive(options,io);
  const runtime=createRuntime(options,io);
  try{return await runtime.enqueue(options.page.url);}finally{runtime.stop();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  main().catch(error=>{console.error(`Błąd: ${errorDetail(error)}`);process.exitCode=1;});
}
