import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import proof from './verification-support.cjs';

const recordings = ['ff-kiwi-ber-cdg', 'ff-sky-ber-cdg'];
const limits = ['Retained recordings verify recorded offers and semantic digests, not current fares or live source access.',
  'Queue scenarios use disposable stores and simulated sources; no challenge is solved automatically.',
  'Desktop model and hook tests do not establish browser appearance or native/Tauri release readiness. No UI interaction changes in this workflow.'];
const catalog = { scenarios: ['recorded-search', 'queue-lifecycle'], commands: ['discover', 'doctor', 'run', 'controls', 'evidence'],
  requiredChecks: ['npm test', 'npm run build', 'uv run pre-commit run --all-files'], recordings, limits };
const env = directory => ({ FLYSCAN_OFFLINE: '1', FLYSCAN_DATA_DIR: path.join(directory, 'data'), FLYSCAN_PYTHON: 'verification-must-not-launch-python' });
function fixtures() {
  return Object.fromEntries(recordings.flatMap(name => fs.readdirSync(path.join('tests/recordings', name)).sort()
    .map(file => [name + '/' + file, proof.digest(fs.readFileSync(path.join('tests/recordings', name, file)))])));
}
function replay(directory, data) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'replay', directory], {
    cwd: path.resolve('backend'), env: { ...process.env, ...env(data) }, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  });
}
async function recorded(run, control) {
  const scratch = path.join(run.directory, 'scratch'); fs.mkdirSync(scratch);
  try {
    for (const name of recordings) await proof.check(run, name, () => {
      const directory = path.resolve('tests/recordings', name);
      const index = JSON.parse(fs.readFileSync(path.join(directory, 'index.json'), 'utf8'));
      assert.ok(index.expect?.offers > 0 && index.expect?.digest?.startsWith('sha256:'), 'recording_requires_count_and_digest');
      const result = replay(directory, scratch);
      fs.writeFileSync(path.join(run.directory, name + '.log'), result.stdout + result.stderr);
      assert.equal(result.status, 0, 'recorded_search_failed');
      assert.equal(JSON.parse(result.stdout).offers, index.expect.offers);
    });
    if (control) {
      for (const fault of ['wrong-count', 'wrong-digest', 'truncated-body']) await proof.check(run, fault, () => {
        const copy = path.join(scratch, fault);
        fs.cpSync(path.resolve('tests/recordings', recordings[0]), copy, { recursive: true });
        const index = JSON.parse(fs.readFileSync(path.join(copy, 'index.json'), 'utf8'));
        if (fault === 'wrong-count') index.expect.offers++;
        if (fault === 'wrong-digest') index.expect.digest = 'sha256:' + '0'.repeat(32);
        if (fault === 'truncated-body') for (const exchange of index.exchanges) exchange.truncated = true;
        fs.writeFileSync(path.join(copy, 'index.json'), JSON.stringify(index));
        const result = replay(copy, scratch);
        fs.writeFileSync(path.join(run.directory, fault + '.log'), result.stdout + result.stderr);
        assert.equal(result.status, 1, 'fault_was_not_rejected');
        assert.match(result.stderr, fault === 'truncated-body' ? /recorded response was truncated/ : /recording outcome differs from its expectation/);
      });
      run.record.control = 'Real CLI replay rejected changed count, changed digest and truncated recorded responses; source fixtures stayed unchanged.';
    }
  } finally {
    assert.equal(path.dirname(scratch), run.directory);
    fs.rmSync(scratch, { recursive: true, force: true }); run.record.cleanup = 'completed';
  }
}
async function queue(run) {
  const scratch = path.join(run.directory, 'scratch'); fs.mkdirSync(scratch);
  try {
    await proof.command(run, 'scheduler-and-api', [process.execPath, '--import', 'tsx', '--test',
      'tests/scheduler.test.ts', 'tests/api.test.ts'], { cwd: path.resolve('backend'), env: env(scratch) });
    await proof.command(run, 'desktop-queue-model-and-connection', [process.execPath, '--test', 'tests/queue.test.cjs',
      'tests/queueConnection.test.cjs', 'tests/useQueue.test.cjs'], { cwd: path.resolve('desktop'), env: env(scratch) });
  } finally {
    assert.equal(path.dirname(scratch), run.directory);
    fs.rmSync(scratch, { recursive: true, force: true }); run.record.cleanup = 'completed';
  }
}
async function main() {
  const [command = 'discover', target, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('unexpected_arguments');
  if (command === 'discover' && !target) return console.log(JSON.stringify(catalog, null, 2));
  if (command === 'doctor' && !target) {
    const ready = Number(process.versions.node.split('.')[0]) >= 24 && fs.existsSync('backend/node_modules/tsx/dist/cli.mjs') && fs.existsSync('desktop/node_modules/typescript/bin/tsc');
    console.log(JSON.stringify({ status: ready ? 'ready' : 'blocked', node: process.version, source: proof.identity(),
      remedy: 'Use Node 24+, npm ci --prefix backend, npm ci --prefix desktop. Run the transport prerequisites separately as documented.' }));
    if (!ready) process.exitCode = 1;
    return;
  }
  if (command === 'evidence') {
    const record = proof.evidence(target); console.log(JSON.stringify(record, null, 2));
    if (!record.sourceMatches || record.status !== 'passed') process.exitCode = 1;
    return;
  }
  if (!['run', 'controls'].includes(command) || !catalog.scenarios.includes(target) || command === 'controls' && target !== 'recorded-search') throw new Error('unknown_scenario');
  const run = proof.begin(target, fixtures(), limits);
  const record = await proof.finish(run, () => target === 'recorded-search' ? recorded(run, command === 'controls') : queue(run));
  console.log(JSON.stringify(record, null, 2));
  if (record.status !== 'passed') process.exitCode = 1;
}
main().catch(error => { console.error(JSON.stringify({ status: 'blocked', error: error.message })); process.exitCode = 1; });
