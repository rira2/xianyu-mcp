#!/usr/bin/env node
/**
 * Run one benchmark spec against a real server, over the same MCP stdio protocol a client speaks:
 * one `node dist/index.js` process, the spec's calls in order, and no retries. A query that fails is
 * a measured row; a fault of the harness or of the protocol exits 2.
 *
 * Usage: node scripts/bench-scan.mjs <spec.json> [--out DIR] [--tool search_items|search_batch] [--timeout S] [--repeat N]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { formatTable, parseSpec, summarize } from './bench-lib.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const ENTRY = join(ROOT, 'dist', 'index.js');
const USAGE = 'usage: node scripts/bench-scan.mjs <spec.json> [--out DIR] [--tool search_items|search_batch] [--timeout S] [--repeat N]';
const TOOLS = ['search_items', 'search_batch'];

const fail = (message) => {
  process.stderr.write(`bench: ${message}\n`);
  process.exit(2);
};

let cli;
try {
  cli = parseArgs({
    allowPositionals: true,
    options: { out: { type: 'string' }, tool: { type: 'string' }, timeout: { type: 'string' }, repeat: { type: 'string' } },
  });
} catch (error) {
  fail(`${error.message}\n${USAGE}`);
}
if (cli.positionals.length !== 1) fail(USAGE);
const tool = cli.values.tool ?? 'search_items';
if (!TOOLS.includes(tool)) fail(`unknown --tool ${tool}\n${USAGE}`);
const timeout = cli.values.timeout === undefined ? 180 : Number(cli.values.timeout);
if (!Number.isInteger(timeout) || timeout < 1) fail(`--timeout must be a positive integer\n${USAGE}`);
// `--repeat` re-runs the spec against the SAME server process, which is the only way to observe
// process-local history: a second `search_batch` pass is mostly known listings. Bounded because each
// pass is a live call against a shared site.
const repeat = cli.values.repeat === undefined ? 1 : Number(cli.values.repeat);
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 5) fail(`--repeat must be an integer from 1 to 5\n${USAGE}`);
if (repeat > 1 && tool !== 'search_batch') fail(`--repeat needs --tool search_batch (history is annotated per batch row)\n${USAGE}`);
let outDir = null;
if (cli.values.out !== undefined) {
  if (!cli.values.out.trim()) fail(`--out needs a directory\n${USAGE}`);
  outDir = resolve(cli.values.out);
}

const specPath = resolve(cli.positionals[0]);
let specText;
try {
  specText = readFileSync(specPath, 'utf8');
} catch (error) {
  fail(`cannot read ${specPath}: ${error.message}`);
}
let spec;
try {
  spec = parseSpec(specText);
} catch (error) {
  fail(`${specPath}: ${error.message}`);
}
if (!existsSync(ENTRY)) fail(`${ENTRY} is missing; run npm run build first`);
if (outDir) mkdirSync(outDir, { recursive: true });

// Goofish resets connections that arrive through the local VPN proxy, and Chromium reads the *_proxy
// variables itself, so they are dropped for the child rather than only for this script.
const env = { ...process.env, DISPLAY: process.env.DISPLAY || ':0', XIANYU_CALL_TIMEOUT_S: '600', no_proxy: '*' };
for (const key of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) delete env[key];

const child = spawn(process.execPath, [ENTRY], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
let buffered = '';
let childStderr = '';
let exit = null;
const pending = new Map();
let nextId = 1;

const rejectPending = (reason) => {
  for (const [id, request] of pending) {
    clearTimeout(request.timer);
    pending.delete(id);
    request.reject(new Error(reason));
  }
};

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf('\n')) >= 0) {
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    const request = message.id === undefined ? null : pending.get(message.id);
    if (!request) continue;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(`JSON-RPC error ${message.error?.code ?? ''}: ${message.error?.message ?? JSON.stringify(message.error)}`));
    else request.resolve(message.result);
  }
});
child.stderr.setEncoding('utf8');
// Kept for diagnostics only; the server's own log would drown the benchmark output.
child.stderr.on('data', (chunk) => { childStderr = (childStderr + chunk).slice(-65536); });
child.on('error', (error) => rejectPending(`could not start the server: ${error.message}`));
child.on('exit', (code, signal) => {
  exit = { code, signal };
  rejectPending(`the server exited (code ${code}, signal ${signal}) before answering`);
});
// An exit is reported by the 'exit' handler; an EPIPE on a write is not a second, competing error.
child.stdin.on('error', () => {});

const send = (method, params, timeoutMs) => new Promise((resolveRequest, rejectRequest) => {
  if (exit) return rejectRequest(new Error(`the server has already exited (code ${exit.code}, signal ${exit.signal})`));
  const id = nextId++;
  const timer = setTimeout(() => {
    pending.delete(id);
    rejectRequest(new Error(`no reply to ${method} within ${Math.round(timeoutMs / 1000)}s`));
  }, timeoutMs);
  timer.unref?.();
  pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  } catch (error) {
    clearTimeout(timer);
    pending.delete(id);
    rejectRequest(new Error(`could not write ${method}: ${error.message}`));
  }
});
const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);

const stopServer = () => new Promise((done) => {
  if (exit) return done();
  const force = setTimeout(() => child.kill('SIGKILL'), 8000);
  force.unref?.();
  child.once('exit', () => { clearTimeout(force); done(); });
  try { child.stdin.end(); } catch { child.kill('SIGTERM'); }
});

const resultText = (result, label) => {
  const text = (result?.content ?? []).find((part) => part?.type === 'text')?.text;
  if (typeof text !== 'string') throw new Error(`${label}: the tool result carried no text content`);
  return text;
};
const parseEnvelope = (text, label) => {
  let envelope;
  try { envelope = JSON.parse(text); } catch { throw new Error(`${label}: the tool result text is not JSON`); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error(`${label}: the tool result is not an object`);
  return envelope;
};
const countOf = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
const statusOf = (value, ok) => (typeof value === 'string' ? value : ok ? 'success' : 'error');
const queryArgs = (entry) => ({
  query: entry.query,
  ...(entry.pages !== undefined ? { pages: entry.pages } : {}),
  ...(entry.limit !== undefined ? { limit: entry.limit } : {}),
});
const writeRaw = (name, text) => {
  if (outDir) writeFileSync(join(outDir, name), text);
};

try {
  await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'xianyu-bench', version: '0.1.0' },
  }, 60_000);
  notify('notifications/initialized', {});

  const listed = await send('tools/list', {}, 30_000);
  const advertised = (listed?.tools ?? []).find((entry) => entry?.name === tool);
  if (!advertised) {
    const names = (listed?.tools ?? []).map((entry) => entry.name).join(', ') || 'none';
    throw new Error(`this build does not expose ${tool} (it exposes: ${names})`);
  }
  // `compact` is what the harness exists to measure, but it is younger than the harness: a build
  // that does not advertise it rejects the argument outright (the server validates strictly), which
  // would turn every query into an error row instead of measuring anything. Ask first, then use it.
  const compact = Boolean(advertised.inputSchema?.properties?.compact);
  if (!compact && tool === 'search_items') {
    process.stderr.write(`bench: this build's ${tool} advertises no compact argument; measuring full-size output\n`);
  }

  const rows = [];
  if (tool === 'search_batch') {
    // One envelope answers every query. `--repeat` re-runs the same list against this same server
    // process: the first pass pays for goofish, and the second answers mostly from process-local
    // history, so `totals.new_listings` on that pass is the novelty measurement the history store
    // exists for. Only the first pass feeds the table; the later passes are printed and saved.
    const repeatPass = async (pass) => {
      process.stderr.write(`bench: ${tool} pass ${pass}/${repeat}, ${spec.length} queries, timeout ${timeout}s\n`);
      const started = Date.now();
      const result = await send('tools/call', {
        name: tool,
        arguments: { queries: spec.map(queryArgs), ...(compact ? { compact: true } : {}), timeout_s: timeout },
      }, (timeout + 30) * 1000);
      const wall = Date.now() - started;
      const text = resultText(result, tool);
      writeRaw(pass === 1 ? 'batch.json' : `batch-pass${pass}.json`, text);
      const envelope = parseEnvelope(text, tool);
      if (envelope.ok !== true) throw new Error(`${tool} returned ${statusOf(envelope.status, false)}: ${envelope.message ?? 'no message'}`);
      const answered = envelope.data?.queries;
      if (!Array.isArray(answered)) throw new Error(`${tool} returned no data.queries array`);
      process.stderr.write(`bench: ${tool} pass ${pass} answered ${answered.length}/${spec.length} queries in ${(wall / 1000).toFixed(1)}s\n`);
      const totals = envelope.data?.totals ?? {}, history = envelope.data?.history ?? {};
      process.stderr.write(`bench: pass ${pass}: totals.new_listings=${totals.new_listings ?? 'absent'} totals.known_listings=${totals.known_listings ?? 'absent'} history.tracked=${history.tracked ?? 'absent'}\n`);
      const passRows = answered.map((entry, position) => {
        const index = Number.isInteger(entry?.index) && entry.index >= 0 && entry.index < spec.length ? entry.index : position;
        const ok = entry?.ok === true;
        return {
          slug: spec[index]?.slug ?? `query-${index + 1}`,
          ok,
          status: statusOf(entry?.status, ok),
          count: countOf(entry?.count),
          ms: Number.isFinite(entry?.ms) ? entry.ms : 0,
          bytes: Buffer.byteLength(JSON.stringify(entry), 'utf8'),
        };
      });
      return { pass, wall, rows: passRows, totals, history };
    };
    const passes = [];
    for (let pass = 1; pass <= repeat; pass++) passes.push(await repeatPass(pass));
    rows.push(...passes[0].rows);
    if (passes.length > 1 && outDir) {
      writeFileSync(join(outDir, 'repeat.json'), `${JSON.stringify(passes.map(({ pass, wall, totals, history }) => ({ pass, wall_ms: wall, totals, history })), null, 2)}\n`);
    }
  } else {
    for (const [index, entry] of spec.entries()) {
      process.stderr.write(`bench: [${index + 1}/${spec.length}] ${entry.slug}: ${entry.query}\n`);
      const started = Date.now();
      const result = await send('tools/call', {
        name: tool,
        arguments: { ...queryArgs(entry), attempts: 3, timeout_s: 150, ...(compact ? { compact: true } : {}) },
      }, (timeout + 30) * 1000);
      const ms = Date.now() - started;
      const text = resultText(result, entry.slug);
      writeRaw(`${entry.slug}.json`, text);
      const envelope = parseEnvelope(text, entry.slug);
      const ok = envelope.ok === true;
      rows.push({
        slug: entry.slug,
        ok,
        status: statusOf(envelope.status, ok),
        count: countOf(envelope.count),
        ms,
        bytes: Buffer.byteLength(text, 'utf8'),
      });
    }
  }

  const summary = summarize(rows);
  process.stdout.write(`${formatTable(rows)}\n`);
  const summaryPath = outDir ? join(outDir, 'summary.json') : resolve(process.cwd(), 'summary.json');
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  process.stderr.write(`bench: summary -> ${summaryPath}\n`);
  if (outDir) process.stderr.write(`bench: envelopes -> ${outDir}\n`);
} catch (error) {
  process.stderr.write(`bench: ${error.message}\n`);
  if (childStderr.trim()) {
    process.stderr.write(`--- server stderr (last 20 lines) ---\n${childStderr.trim().split('\n').slice(-20).join('\n')}\n`);
  }
  process.exitCode = 2;
} finally {
  await stopServer();
}
