import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ascUrl, available, builds, check, retainReceipt } from '../buzz_ios_asc.mjs';

const app = { data: { type: 'apps', id: '6809565361', attributes: { bundleId: 'com.sats21m.buzz' } } };
const row = (number, state) => ({ type: 'builds', id: `id-${number}`, attributes: { version: number, processingState: state } });

test('availability rejects collision, superseded numbers and unknown numbering', () => {
  available([], '1');
  available([{ number: '8' }], '9');
  for (const number of ['9', '10', '1.2', 'unknown']) assert.throws(() => available([{ number }], '9'));
});

test('pagination checks every page and rejects cycles before another request', async () => {
  const pages = [{ data: [], links: { next: 'https://api.appstoreconnect.apple.com/v1/builds?page=2' } },
    { data: [row('1', 'VALID')] }];
  assert.equal((await builds('0.5.9', 'fixture', async () => pages.shift()))[0].number, '1');
  let calls = 0;
  await assert.rejects(builds('0.5.9', 'fixture', async () => {
    calls++;
    return { data: [], links: { next: 'https://api.appstoreconnect.apple.com/v1/builds?page=2' } };
  }), /pagination/);
  assert.equal(calls, 2);
});

test('bearer never follows a foreign origin or credentials in a URL', async () => {
  for (const url of ['http://api.appstoreconnect.apple.com/v1/builds', 'https://evil.example/v1/builds',
    'https://api.appstoreconnect.apple.com@evil.example/v1/builds', 'https://user@api.appstoreconnect.apple.com/v1/builds']) {
    assert.throws(() => ascUrl(url), /unexpected ASC URL/);
  }
  let calls = 0;
  await assert.rejects(builds('0.5.9', 'fixture', async () => {
    calls++;
    return { data: [], links: { next: 'https://evil.example/v1/builds' } };
  }), /unexpected ASC URL/);
  assert.equal(calls, 1);
});

test('processing ignores another valid number and waits for the exact build', async () => {
  const pages = [app, { data: [row('1', 'VALID')] }, { data: [row('2', 'PROCESSING')] }, { data: [row('2', 'VALID')] }];
  let sleeps = 0;
  const result = await check({ action: 'processed', version: '0.5.9', number: '2', makeToken: () => 'fixture',
    request: async () => pages.shift(), sleep: async () => { sleeps++; } });
  assert.equal(sleeps, 2);
  assert.equal(result.build.id, 'id-2');
  assert.equal(result.processing_verified, true);
  assert.equal(result.installed_verified, false);
});

test('failed, invalid, unknown and ambiguous exact builds never pass', async () => {
  for (const data of [[row('2', 'FAILED')], [row('2', 'INVALID')], [row('2', 'other')], [row('2', 'VALID'), row('2', 'VALID')]]) {
    const pages = [app, { data }];
    await assert.rejects(check({ action: 'processed', version: '0.5.9', number: '2', makeToken: () => 'fixture',
      request: async () => pages.shift() }));
  }
});

test('different app identity stops before build inventory', async () => {
  let calls = 0;
  await assert.rejects(check({ action: 'available', version: '0.5.9', number: '1', makeToken: () => 'fixture',
    request: async () => { calls++; return { data: { ...app.data, attributes: { bundleId: 'com.other.app' } } }; } }), /identity/);
  assert.equal(calls, 1);
});

test('collision fails only after its exact inventory is retained', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'buzz-asc-public-fixture-'));
  try {
    const pages = [app, { data: [row('3', 'VALID'), row('4', 'PROCESSING')] }];
    const receipt = await check({ action: 'available', version: '0.5.9', number: '3',
      makeToken: () => 'private-token-fixture', request: async () => pages.shift() });
    assert.equal(receipt.available, false);
    assert.equal(receipt.classification, 'BUILD_NUMBER_UNAVAILABLE');
    await assert.rejects(retainReceipt('available', receipt, directory), /inventory retained/);
    const bytes = await readFile(join(directory, 'asc-available.json'), 'utf8');
    assert.deepEqual(JSON.parse(bytes).existing_builds, [
      { id: 'id-3', number: '3', state: 'VALID' }, { id: 'id-4', number: '4', state: 'PROCESSING' },
    ]);
    assert.equal(bytes.includes('private-token-fixture'), false);
  } finally { await rm(directory, { recursive: true }); }
});

test('actual collision CLI exits nonzero after writing inventory without secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'buzz-asc-cli-public-fixture-'));
  try {
    // Execute the unchanged CLI bytes, replacing only its network/crypto client
    // with deterministic public fixtures. This checks the real exit boundary.
    await writeFile(join(directory, 'buzz_ios_asc.mjs'), await readFile(new URL('../buzz_ios_asc.mjs', import.meta.url)));
    await writeFile(join(directory, 'app_store_connect_preflight.mjs'), `
      export const parsePrivateKey = () => 'private-key-fixture';
      export const createToken = () => 'private-token-fixture';
      export const requestJson = async url => url.pathname.includes('/apps/')
        ? ${JSON.stringify(app)} : { data: [${JSON.stringify(row('1', 'VALID'))}] };
    `);
    await mkdir(join(directory, 'signed-ios'));
    const result = spawnSync(process.execPath, [join(directory, 'buzz_ios_asc.mjs'), 'available',
      '--version', '0.5.9', '--build-number', '1'], { cwd: directory, encoding: 'utf8',
      env: { PATH: process.env.PATH, RUNNER_ENVIRONMENT: 'github-hosted', ASC_API_KEY_P8: 'private-key-fixture',
        ASC_KEY_ID: 'private-id-fixture', ASC_ISSUER_ID: 'private-issuer-fixture' } });
    assert.equal(result.status, 1);
    const bytes = await readFile(join(directory, 'signed-ios/asc-available.json'), 'utf8');
    assert.equal(JSON.parse(bytes).classification, 'BUILD_NUMBER_UNAVAILABLE');
    for (const field of ['private-key-fixture', 'private-id-fixture', 'private-issuer-fixture', 'private-token-fixture']) {
      assert.equal((result.stdout + result.stderr + bytes).includes(field), false);
    }
  } finally { await rm(directory, { recursive: true }); }
});
