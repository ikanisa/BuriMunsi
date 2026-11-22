// Source-bound observations of real WASM dependencies in pinned Edge Runtime.
// Completed observations never constitute an accepted roster parser contract.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdir, open, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const HERE = import.meta.dirname;
const BINARY_SHA = '7883510fe308b4b5c49ec0a8e2020ec81c5fa41133239f3969a372b1cbf107ba';
const HOST = '127.0.0.1';
const PORT = 9178;
const ORIGIN = `http://${HOST}:${PORT}`;
const IMAGE_STRICT = 'warning_strict_and_explicit_apng';
const sha = value => createHash('sha256').update(value).digest('hex');

async function snapshot(root) {
  const files = [];
  async function walk(relative) {
    const path = join(root, relative);
    const stat = await lstat(path);
    assert(!stat.isSymbolicLink(), 'Probe inputs cannot be symlinks');
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        if (name !== '__pycache__') await walk(relative ? `${relative}/${name}` : name);
      }
    } else {
      assert(stat.isFile());
      files.push({ path: relative, sha256: sha(await readFile(path)) });
    }
  }
  await walk('');
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

async function requireFresh(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw Error('Fresh output path required');
}

async function readFixtures(prepared, source) {
  const manifestPath = 'corpus/manifest.json';
  const manifestBytes = await readFile(join(prepared, manifestPath));
  const original = source.find(file => file.path === manifestPath);
  assert.equal(sha(manifestBytes), original?.sha256, 'Prepared corpus manifest identity');
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.synthetic_only, true);
  assert.equal(manifest.fixtures.length, 35);

  const fixtures = { image: [], pdf: [] };
  for (const fixture of manifest.fixtures) {
    if (!['image', 'pdf'].includes(fixture.kind)) continue;
    assert.match(fixture.path, /^[a-z0-9.-]+$/);
    const data = await readFile(join(prepared, 'corpus', fixture.path));
    assert.equal(sha(data), fixture.sha256, 'Prepared corpus fixture identity');
    fixtures[fixture.kind].push({ ...fixture, base64: data.toString('base64') });
  }
  return fixtures;
}

async function requireAvailablePort() {
  const listener = createServer();
  await new Promise((ready, reject) => {
    listener.once('error', reject);
    listener.listen(PORT, HOST, ready);
  });
  await new Promise((closed, reject) => {
    listener.close(error => error ? reject(error) : closed());
  });
}

function runtimeRunning(child) {
  return child?.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

async function readProbeResponse(response) {
  assert(response.body, 'Probe response body required');
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of response.body) {
    text += decoder.decode(chunk, { stream: true });
    assert(text.length <= 16384, 'Probe response limit');
  }
  text += decoder.decode();
  assert(text.length <= 16384, 'Probe response limit');
  return JSON.parse(text);
}

function probeRequest(path, options) {
  return fetch(`${ORIGIN}/${path}`, { ...options, redirect: 'error' });
}

async function waitForRuntime(child, childError) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const error = childError();
    if (error) throw error;
    if (!runtimeRunning(child)) throw Error('Native probe runtime exited');
    try {
      const response = await probeRequest('ready', { signal: AbortSignal.timeout(500) });
      const body = await readProbeResponse(response);
      if (response.status === 404 && body.code === 'not_found') return;
    } catch {
      // The loopback listener may still be booting.
    }
    await sleep(100);
  }
  throw Error('Native probe startup deadline');
}

async function stopRuntime(child) {
  for (const [signal, timeout] of [['SIGTERM', 15000], ['SIGKILL', 5000]]) {
    if (!runtimeRunning(child)) return;
    child.kill(signal);
    const deadline = Date.now() + timeout;
    while (runtimeRunning(child) && Date.now() < deadline) await sleep(100);
  }
  assert(!runtimeRunning(child), 'Owned native probe runtime did not stop');
}

function imageFormat(path, strict) {
  if (path.endsWith('.jpg')) return 'Jpeg';
  if (path.endsWith('.png')) return strict && path.startsWith('animation-') ? 'APng' : 'Png';
  return 'WebP';
}

async function observeFixture(lane, fixture, results, options = {}) {
  const started = Date.now();
  const response = await probeRequest(lane, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base64: fixture.base64, ...options }),
    signal: AbortSignal.timeout(20000),
  });
  const value = await readProbeResponse(response);
  const result = {
    lane,
    fixture: fixture.path,
    fixture_sha256: fixture.sha256,
    expected_accept: fixture.accepted,
    http_status: response.status,
    response: value,
    elapsed_ms: Date.now() - started,
    acceptance_matches_expected: value.ok === fixture.accepted,
  };
  if (fixture.path.startsWith('animation-3.') || fixture.path.startsWith('animation-21.')) {
    result.expected_frames = fixture.path.startsWith('animation-3.') ? 3 : 21;
    result.complete_frame_decode_match = value.ok === true ? value.frames === result.expected_frames : null;
  }
  results.push(result);
  assert.notEqual(value.stage, 'worker_boot', 'Real parser worker must boot');
  return result;
}

async function observeCorpus(fixtures, results) {
  for (const strict of [false, true]) {
    for (const fixture of fixtures.image) {
      const observed = await observeFixture('image', fixture, results, {
        format: imageFormat(fixture.path, strict),
        strict,
      });
      observed.image_mode = strict ? IMAGE_STRICT : 'default';
    }
  }
  for (const lane of ['pdfium', 'qpdf']) {
    for (const fixture of fixtures.pdf) await observeFixture(lane, fixture, results);
  }
  const examplePdf = fixtures.pdf.find(fixture => fixture.path === 'pages-2.pdf');
  const version = await observeFixture('qpdf', examplePdf, results, { version: true });
  version.engine_version_observation = true;
  assert.match(version.response.output, /^(?:qpdf|this\.program) version 12\.2\.0(?:\n|$)/);
}

function summarizeFindings(results) {
  const get = (lane, path, mode) => results.find(item =>
    item.lane === lane && item.fixture === path && (!mode || item.image_mode === mode));
  const structural = results.filter(item => item.lane === 'qpdf' && !item.engine_version_observation);
  return {
    default_jpeg_accepts_truncation: get('image', 'truncated.jpg', 'default')?.response.ok === true,
    strict_warning_check_rejects_truncated_jpeg: get('image', 'truncated.jpg', IMAGE_STRICT)?.response.ok === false,
    default_png_drops_animation_frames: get('image', 'animation-3.png', 'default')?.response.frames === 1,
    default_png_accepts_over_limit_animation: get('image', 'animation-21.png', 'default')?.response.ok === true,
    explicit_apng_codec_rejects_valid_animation: get('image', 'animation-3.png', IMAGE_STRICT)?.response.ok === false,
    rendering_alone_accepts_active_pdf: get('pdfium', 'javascript.pdf')?.response.ok === true,
    rendering_alone_accepts_expansion_pdf: get('pdfium', 'object-stream-expansion.pdf')?.response.ok === true,
    qpdf_structure_matches_ten_existing_pdf_labels: structural.length === 10 && structural.every(item => item.acceptance_matches_expected),
  };
}

function failureSummary(error) {
  return { name: error.name, message: String(error.message).slice(0, 240) };
}

async function run(binary, prepared, attempt, receipt) {
  assert.equal(process.env.COLLECT_CI_SYNTHETIC, 'true');
  assert.equal(sha(await readFile(binary)), BINARY_SHA);
  await requireFresh(attempt);
  await requireFresh(receipt);

  const preparedReceipt = JSON.parse(await readFile(join(prepared, 'prepared.json'), 'utf8'));
  assert.equal(preparedReceipt.contract, 'collect.roster.native-probe.prepared.v1');
  assert.equal(preparedReceipt.synthetic_only, true);
  const sourceBefore = await snapshot(HERE);
  assert.deepEqual(sourceBefore, preparedReceipt.source_inputs, 'Prepared services must bind the current exact probe source');
  const preparedBefore = await snapshot(prepared);
  const fixtures = await readFixtures(prepared, sourceBefore);
  await requireAvailablePort();

  await mkdir(attempt, { mode: 0o700 });
  const log = await open(join(attempt, 'runtime.private.log'), 'wx', 0o600);
  let child;
  let childError;
  let failure = null;
  const results = [];
  try {
    child = spawn(binary, [
      'start', '--ip', HOST, '--port', String(PORT), '--main-service', join(prepared, 'main'),
      '--policy', 'oneshot', '--max-parallelism', '1',
    ], {
      cwd: attempt,
      env: {
        PATH: process.env.PATH,
        DENO_DIR: join(attempt, 'cache'),
        DENO_NO_UPDATE_CHECK: '1',
        QUAL_ISOLATION_SENTINEL: 'SYNTHETIC_CANARY',
      },
      stdio: ['ignore', log.fd, log.fd],
    });
    child.on('error', error => { childError = error; });
    await once(child, 'spawn');
    await waitForRuntime(child, () => childError);
    await observeCorpus(fixtures, results);
  } catch (error) {
    failure = failureSummary(error);
  } finally {
    try {
      await stopRuntime(child);
    } catch (error) {
      failure = failureSummary(error);
    } finally {
      await log.close();
    }
  }

  try {
    assert.deepEqual(await snapshot(HERE), sourceBefore, 'Probe source changed during execution');
    assert.deepEqual(await snapshot(prepared), preparedBefore, 'Prepared dependency/corpus bytes changed during execution');
    assert.equal(sha(await readFile(binary)), BINARY_SHA);
  } catch (error) {
    failure = failureSummary(error);
  }

  const findings = summarizeFindings(results);
  const result = {
    contract: 'collect.roster.native-dependency-observations.v2',
    status: failure ? 'incomplete' : 'completed',
    checked_at: new Date().toISOString(),
    binary_sha256: BINARY_SHA,
    runtime: 'supabase/edge-runtime:v1.77.4',
    native_deno: '2.1.4',
    synthetic_only: true,
    parser_contract_qualified: false,
    production_acceptance: false,
    provider_accuracy_verified: false,
    provider_calls: 0,
    original_signed_decoder_contract_implemented: false,
    native_workbook_decoder_implemented: false,
    source_inputs: sourceBefore,
    source_sha256: sha(JSON.stringify(sourceBefore)),
    prepared_inputs: preparedBefore,
    prepared_sha256: sha(JSON.stringify(preparedBefore)),
    dependencies: preparedReceipt.packages,
    configured_worker_limits: {
      memory_mb: 384,
      cpu_soft_ms: 4000,
      cpu_hard_ms: 5000,
      wall_ms: 10000,
      fresh_worker_per_request: true,
      network_denied: true,
      environment_denied: true,
      filesystem_write_denied: true,
      subprocess_denied: true,
      concurrency: 1,
    },
    resource_exhaustion_acceptance: false,
    file_read_not_found_is_not_permission_denial: true,
    findings,
    results,
    failure,
    native_process_stopped: !runtimeRunning(child),
    private_log_retained: true,
  };
  await writeFile(receipt, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({
    status: result.status,
    observations: results.length,
    findings,
    parser_contract_qualified: false,
    production_acceptance: false,
  }));
  if (failure) process.exitCode = 1;
}

assert.equal(process.argv.length, 6, 'binary prepared-directory fresh-private-attempt safe-receipt required');
await run(...process.argv.slice(2).map(value => resolve(value)));
