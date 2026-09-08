#!/usr/bin/env node
// Read-only Buzz TestFlight checks using the existing trusted ASC client.
import { createToken, parsePrivateKey, requestJson } from './app_store_connect_preflight.mjs';
import { writeFile, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const APP = '6809565361';
const BUNDLE = 'com.sats21m.buzz';
const ORIGIN = 'https://api.appstoreconnect.apple.com';
const require = (condition, message) => { if (!condition) throw new Error(message); };

export function ascUrl(value) {
  const url = new URL(value);
  require(url.origin === ORIGIN && url.pathname.startsWith('/v1/') && !url.username && !url.password && !url.hash,
    'unexpected ASC URL');
  return url;
}

export async function builds(version, token, request = requestJson) {
  let url = new URL('/v1/builds', ORIGIN);
  for (const [key, value] of Object.entries({
    'filter[app]': APP, 'filter[preReleaseVersion.version]': version,
    'filter[preReleaseVersion.platform]': 'IOS', 'fields[builds]': 'version,processingState', limit: '200',
  })) url.searchParams.set(key, value);
  const items = [];
  const seen = new Set();
  while (url) {
    url = ascUrl(url);
    require(!seen.has(url.href) && seen.size < 50, 'invalid ASC pagination');
    seen.add(url.href);
    const response = await request(url, token);
    require(Array.isArray(response.data), 'invalid ASC build list');
    for (const item of response.data) {
      require(item.type === 'builds' && typeof item.id === 'string' &&
        typeof item.attributes?.version === 'string' && typeof item.attributes?.processingState === 'string',
      'invalid ASC build');
      items.push({ id: item.id, number: item.attributes.version, state: item.attributes.processingState });
    }
    url = response.links?.next;
  }
  return items;
}

export function available(items, number) {
  require(items.every(item => /^[1-9][0-9]{0,8}$/.test(item.number)), 'unorderable ASC build number');
  require(items.every(item => Number(item.number) < Number(number)), 'ASC build number already used or superseded');
}

export async function check({ action, version, number, makeToken, request = requestJson,
  sleep = ms => new Promise(done => setTimeout(done, ms)) }) {
  let token = makeToken();
  const { data: app } = await request(ascUrl(`${ORIGIN}/v1/apps/${APP}?fields%5Bapps%5D=bundleId`), token);
  require(app?.type === 'apps' && app.id === APP && app.attributes?.bundleId === BUNDLE, 'ASC app identity differs');
  const deadline = Date.now() + 20 * 60_000;
  for (let attempt = 0; attempt <= 40; attempt++) {
    if (attempt && attempt % 8 === 0) token = makeToken();
    const items = await builds(version, token, request);
    if (action === 'available') {
      available(items, number);
      return { available: true, existing_builds: items };
    }
    const matches = items.filter(item => item.number === number);
    require(matches.length <= 1, 'ambiguous ASC build identity');
    if (matches.length) {
      const build = matches[0];
      if (build.state === 'VALID') return { processing_verified: true, build, installed_verified: false };
      require(build.state === 'PROCESSING', 'Apple rejected build processing or returned an unknown state');
    }
    require(Date.now() < deadline && attempt < 40, 'Apple processing timeout');
    await sleep(30_000);
  }
  throw new Error('Apple processing timeout');
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true,
    options: { version: { type: 'string' }, 'build-number': { type: 'string' } } });
  const action = positionals[0], version = values.version, number = values['build-number'];
  require(positionals.length === 1 && ['available', 'processed'].includes(action), 'invalid action');
  require(/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version ?? '') && /^[1-9][0-9]{0,8}$/.test(number ?? ''), 'invalid version/build');
  require(process.env.RUNNER_ENVIRONMENT === 'github-hosted', 'hosted signing VM required');
  const credentials = { keyId: process.env.ASC_KEY_ID, issuerId: process.env.ASC_ISSUER_ID,
    privateKey: parsePrivateKey(process.env.ASC_API_KEY_P8) };
  for (const name of ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_API_KEY_P8']) delete process.env[name];
  const receipt = await check({ action, version, number, makeToken: () => createToken(credentials) });
  Object.assign(receipt, { app: APP, source: process.env.SOURCE_SHA, version, build_number: number,
    run_id: process.env.GITHUB_RUN_ID, run_attempt: process.env.GITHUB_RUN_ATTEMPT, workflow_sha: process.env.GITHUB_SHA });
  const output = await lstat('signed-ios');
  require(output.isDirectory() && !output.isSymbolicLink(), 'prepare must pass');
  await writeFile(`signed-ios/asc-${action}.json`, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(`Buzz ASC ${action} check passed.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { await main(); } catch {
    console.error('Buzz ASC check failed; protected inputs and API responses were not logged.');
    process.exitCode = 1;
  }
}
