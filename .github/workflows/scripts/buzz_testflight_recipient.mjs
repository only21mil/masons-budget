#!/usr/bin/env node
// Scoped distribution of the already uploaded Buzz build. Never logs API bodies.
import { createToken, parsePrivateKey } from './app_store_connect_preflight.mjs';
import { ascUrl } from './buzz_ios_asc.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const APP = '6809565361';
export const BUILD = '590b0858-0d5c-4deb-9163-66fc5137f02c';
const GROUP_NAME = 'Buzz private beta';
const ORIGIN = 'https://api.appstoreconnect.apple.com';
const require = (ok, code) => { if (!ok) throw new Error(code); };
const resource = (type, id) => ({ type, id });
const relationship = (type, id) => ({ data: resource(type, id) });
const uuid = value => /^[0-9a-f-]{36}$/i.test(value ?? '');

export function client(makeToken, fetcher = fetch) {
  return async (path, method = 'GET', body) => {
    const url = ascUrl(new URL(path, ORIGIN));
    // No redirects and no automatic mutation retries. A lost response requires fresh inventory.
    const response = await fetcher(url, { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${makeToken()}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const raw = await response.text();
    require(raw.length <= 2_000_000, 'APPLE_RESPONSE_TOO_LARGE');
    const parsed = raw ? JSON.parse(raw) : {};
    if (!response.ok) {
      const error = new Error(`APPLE_HTTP_${response.status}`);
      error.apple = Array.isArray(parsed.errors) ? parsed.errors.slice(0, 20).map(item => ({
        code: /^[A-Z0-9_.-]{1,120}$/.test(item.code ?? '') ? item.code : 'UNCLASSIFIED',
        pointer: /^\/data(?:\/[A-Za-z0-9_]+){0,8}$/.test(item.source?.pointer ?? '') ? item.source.pointer : null,
      })) : [];
      throw error;
    }
    return parsed;
  };
}

async function list(api, path, query = {}) {
  let url = new URL(path, ORIGIN);
  for (const [key, value] of Object.entries({ limit: '200', ...query })) url.searchParams.set(key, value);
  const items = [], seen = new Set();
  while (url) {
    const next = ascUrl(url).href;
    require(!seen.has(next) && seen.size < 50, 'INVALID_PAGINATION');
    seen.add(next);
    const response = await api(next);
    require(Array.isArray(response.data), 'INVALID_COLLECTION');
    items.push(...response.data);
    url = response.links?.next;
  }
  return items;
}

async function recipient(api, email) {
  const matches = await list(api, '/v1/betaTesters', { 'filter[email]': email, 'fields[betaTesters]': 'email,state' });
  require(matches.length <= 1, 'AMBIGUOUS_RECIPIENT');
  if (!matches.length) return null;
  const tester = matches[0];
  require(tester.type === 'betaTesters' && uuid(tester.id) && tester.attributes?.email?.toLowerCase() === email,
    'RECIPIENT_IDENTITY_MISMATCH');
  return tester;
}

async function betaMetadata(api) {
  const present = value => typeof value === 'string' && value.trim().length > 0;
  // Request only these current-app fields. Never retrieve demo-account passwords.
  let detail;
  try {
    ({ data: detail } = await api(`/v1/apps/${APP}/betaAppReviewDetail?fields%5BbetaAppReviewDetails%5D=contactFirstName,contactLastName,contactPhone,contactEmail,demoAccountRequired`));
  } catch (error) { if (error.message !== 'APPLE_HTTP_404') throw error; }
  const contactFields = ['contactFirstName', 'contactLastName', 'contactPhone', 'contactEmail'];
  const missingContact = contactFields.filter(field => !present(detail?.attributes?.[field]));
  const localizations = await list(api, `/v1/apps/${APP}/betaAppLocalizations`, {
    'fields[betaAppLocalizations]': 'description,feedbackEmail,locale' });
  const notes = await list(api, `/v1/builds/${BUILD}/betaBuildLocalizations`, {
    'fields[betaBuildLocalizations]': 'whatsNew,locale' });
  const missingDescriptions = localizations.filter(item => !present(item.attributes?.description)).length;
  return { review_detail_exists: !!detail, missing_contact_fields: missingContact,
    demo_account_required: detail?.attributes?.demoAccountRequired ?? null,
    demo_account_credentials_checked: false, app_localization_count: localizations.length,
    missing_description_count: missingDescriptions,
    feedback_email_present: localizations.some(item => present(item.attributes?.feedbackEmail)),
    build_test_notes_present: notes.some(item => present(item.attributes?.whatsNew)) };
}

export async function inventory(api, email) {
  const { data: app } = await api(`/v1/apps/${APP}`);
  require(app?.id === APP && app.type === 'apps' && app.attributes?.bundleId === 'com.sats21m.buzz', 'APP_MISMATCH');
  const { data: build } = await api(`/v1/builds/${BUILD}`);
  const { data: buildApp } = await api(`/v1/builds/${BUILD}/app`);
  const { data: version } = await api(`/v1/builds/${BUILD}/preReleaseVersion`);
  require(build?.id === BUILD && build.type === 'builds' && buildApp?.id === APP &&
    build.attributes?.version === '1' && build.attributes.processingState === 'VALID' && build.attributes.expired === false &&
    version?.attributes?.version === '0.5.9' && version.attributes.platform === 'IOS', 'BUILD_MISMATCH');
  const { data: beta } = await api(`/v1/builds/${BUILD}/buildBetaDetail`);
  require(beta?.type === 'buildBetaDetails', 'INVALID_BETA_DETAIL');
  const tester = await recipient(api, email);
  const groups = await list(api, '/v1/betaGroups', { 'filter[app]': APP });
  const summaries = [];
  for (const group of groups) {
    require(group.type === 'betaGroups' && uuid(group.id), 'INVALID_GROUP');
    const testers = await list(api, `/v1/betaGroups/${group.id}/relationships/betaTesters`);
    const builds = await list(api, `/v1/betaGroups/${group.id}/relationships/builds`);
    require(typeof group.attributes?.isInternalGroup === 'boolean', 'INVALID_GROUP_KIND');
    summaries.push({ id: group.id, private_group_name_match: group.attributes?.name === GROUP_NAME, internal: group.attributes.isInternalGroup,
      public_link: group.attributes?.publicLinkEnabled, all_builds: group.attributes?.hasAccessToAllBuilds,
      tester_count: testers.length, recipient_member: !!tester && testers.some(item => item.id === tester.id),
      other_testers: testers.some(item => item.id !== tester?.id), build_member: builds.some(item => item.id === BUILD),
      other_builds: builds.some(item => item.id !== BUILD) });
  }
  const individualTesters = await list(api, `/v1/builds/${BUILD}/relationships/individualTesters`);
  const unrelatedAudience = individualTesters.some(item => item.id !== tester?.id) ||
    summaries.some(group => group.build_member && group.other_testers);
  return { tester, receipt: { app: APP, build: BUILD, version: '0.5.9', build_number: '1', processing: 'VALID',
    internal_state: beta.attributes?.internalBuildState, external_state: beta.attributes?.externalBuildState,
    beta_metadata: await betaMetadata(api), unrelated_build_audience: unrelatedAudience, recipient_exists: !!tester, recipient_state: tester?.attributes?.state ?? null, groups: summaries } };
}

export async function operate({ api, email, action, groupId, record = async () => {} }) {
  require(['inventory', 'distribute'].includes(action), 'INVALID_ACTION');
  require(typeof email === 'string' && email === email.trim().toLowerCase() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'INVALID_RECIPIENT');
  const before = await inventory(api, email);
  await record('before', before.receipt);
  if (action === 'inventory') return { status: 'INVENTORY_ONLY', ...before.receipt };
  require(groupId === 'new-private' || uuid(groupId), 'EXPLICIT_GROUP_REQUIRED');
  let group;
  if (groupId === 'new-private') {
    const existing = before.receipt.groups.filter(item => item.private_group_name_match);
    require(existing.length <= 1, 'AMBIGUOUS_PRIVATE_GROUP');
    group = existing[0];
    if (!group) {
      const { data } = await api('/v1/betaGroups', 'POST', { data: { type: 'betaGroups',
        attributes: { name: GROUP_NAME, isInternalGroup: false, publicLinkEnabled: false, hasAccessToAllBuilds: false },
        relationships: { app: relationship('apps', APP) } } });
      require(data?.type === 'betaGroups' && uuid(data.id), 'INVALID_CREATED_GROUP');
      group = (await inventory(api, email)).receipt.groups.find(item => item.id === data.id);
      await record('group-created', { id: data.id });
    }
  } else group = before.receipt.groups.find(item => item.id === groupId);
  require(groupId !== 'new-private' || group?.internal === false, 'EXTERNAL_GROUP_REQUIRED');
  require(group && group.public_link === false && group.all_builds === false, 'GROUP_NOT_PRIVATE_AND_SCOPED');
  // Existing internal access may be reused; this tool never grants team or app roles.
  require(!group.internal || group.recipient_member, 'INTERNAL_MEMBERSHIP_REQUIRED');
  require(group.recipient_member || !group.other_builds, 'MEMBERSHIP_WOULD_GRANT_OTHER_BUILDS');
  // Adding a build must not send it to an unrelated tester. Choose the dedicated group instead.
  require(group.build_member || !group.other_testers, 'BUILD_WOULD_REACH_OTHER_TESTERS');
  if (!group.build_member) {
    await api(`/v1/betaGroups/${group.id}/relationships/builds`, 'POST', { data: [resource('builds', BUILD)] });
    await record('build-assigned', { group: group.id, build: BUILD });
  }
  let tester = before.tester;
  if (!tester) {
    require(!group.internal, 'EXTERNAL_GROUP_REQUIRED');
    const { data } = await api('/v1/betaTesters', 'POST', { data: { type: 'betaTesters', attributes: { email },
      relationships: { betaGroups: { data: [resource('betaGroups', group.id)] } } } });
    require(data?.type === 'betaTesters' && uuid(data.id), 'INVALID_CREATED_TESTER');
    await record('recipient-created', { created: true });
    tester = await recipient(api, email);
    require(tester?.id === data.id, 'CREATED_RECIPIENT_READBACK_MISMATCH');
  } else if (!group.recipient_member) {
    await api(`/v1/betaGroups/${group.id}/relationships/betaTesters`, 'POST', { data: [resource('betaTesters', tester.id)] });
    await record('recipient-assigned', { group: group.id });
  }
  let current = await inventory(api, email);
  if (!group.internal && current.receipt.external_state === 'READY_FOR_BETA_SUBMISSION') {
    require(!current.receipt.unrelated_build_audience, 'BETA_REVIEW_WOULD_NOTIFY_OTHER_TESTERS');
    const metadata = current.receipt.beta_metadata;
    require(metadata.review_detail_exists && metadata.missing_contact_fields.length === 0 &&
      metadata.app_localization_count > 0 && metadata.missing_description_count === 0 &&
      metadata.feedback_email_present && metadata.build_test_notes_present, 'BETA_REVIEW_METADATA_INCOMPLETE');
    require(metadata.demo_account_required === false, 'BETA_REVIEW_DEMO_ACCOUNT_REQUIRES_SEPARATE_VERIFICATION');
    const { data } = await api('/v1/betaAppReviewSubmissions', 'POST', { data: { type: 'betaAppReviewSubmissions',
      relationships: { build: relationship('builds', BUILD) } } });
    require(data?.type === 'betaAppReviewSubmissions', 'INVALID_BETA_REVIEW_RECEIPT');
    await record('beta-review-submitted', { id: data.id, state: data.attributes?.betaReviewState });
    current = await inventory(api, email);
  }
  if (!group.internal && current.receipt.external_state === 'READY_FOR_BETA_TESTING') {
    // This endpoint notifies every tester assigned to the build. Refuse a broader audience.
    require(!current.receipt.unrelated_build_audience, 'NOTIFICATION_WOULD_REACH_OTHER_TESTERS');
    const { data } = await api('/v1/buildBetaNotifications', 'POST', { data: { type: 'buildBetaNotifications',
      relationships: { build: relationship('builds', BUILD) } } });
    require(data?.type === 'buildBetaNotifications', 'INVALID_BUILD_NOTIFICATION_RECEIPT');
    await record('build-notification', { accepted: true });
    current = await inventory(api, email);
  }
  const ready = (group.internal ? current.receipt.internal_state : current.receipt.external_state) === 'IN_BETA_TESTING';
  let invitation = 'NOT_SENT_BUILD_UNAVAILABLE';
  if (ready) {
    // Re-read immediately before sending. Never resend INVITED/ACCEPTED/INSTALLED invitations.
    tester = await recipient(api, email);
    require(tester, 'RECIPIENT_MISSING');
    if (tester.attributes.state === 'NOT_INVITED') {
      const { data } = await api('/v1/betaTesterInvitations', 'POST', { data: { type: 'betaTesterInvitations',
        relationships: { app: relationship('apps', APP), betaTester: relationship('betaTesters', tester.id) } } });
      require(data?.type === 'betaTesterInvitations', 'INVALID_INVITATION_RECEIPT');
      invitation = 'PROVIDER_ACCEPTED';
      await record('invitation', { status: invitation, id: data.id });
    } else {
      require(['INVITED', 'ACCEPTED', 'INSTALLED'].includes(tester.attributes.state), 'UNKNOWN_INVITATION_STATE');
      invitation = 'EXISTING_INVITATION_OR_ACCEPTANCE';
    }
  }
  const final = (await inventory(api, email)).receipt;
  const finalGroup = final.groups.find(item => item.id === group.id);
  const finalReady = (group.internal ? final.internal_state : final.external_state) === 'IN_BETA_TESTING';
  require(finalGroup?.recipient_member && finalGroup.build_member, 'MEMBERSHIP_READBACK_FAILED');
  return { ...final, status: finalReady && ready ? 'DISTRIBUTED' : 'APPLE_BETA_READINESS_PENDING', selected_group: group.id,
    invitation, build_available: finalReady && ready, physical_install_verified: false };
}

async function main() {
  require(process.env.RUNNER_ENVIRONMENT === 'github-hosted', 'HOSTED_RUNNER_REQUIRED');
  const email = process.env.BUZZ_TESTFLIGHT_RECIPIENT_EMAIL;
  const credentials = { keyId: process.env.ASC_KEY_ID, issuerId: process.env.ASC_ISSUER_ID,
    privateKey: parsePrivateKey(process.env.ASC_API_KEY_P8) };
  for (const key of ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_API_KEY_P8', 'BUZZ_TESTFLIGHT_RECIPIENT_EMAIL']) delete process.env[key];
  await mkdir('testflight-receipts', { mode: 0o700 });
  const record = async (name, receipt) => writeFile(`testflight-receipts/${name}.json`, JSON.stringify({ ...receipt,
    run_id: process.env.GITHUB_RUN_ID, run_attempt: process.env.GITHUB_RUN_ATTEMPT, workflow_sha: process.env.GITHUB_SHA }, null, 2) + '\n',
  { flag: 'wx', mode: 0o600 });
  try {
    const result = await operate({ api: client(() => createToken(credentials)), email,
      action: process.env.TESTFLIGHT_ACTION, groupId: process.env.TESTFLIGHT_GROUP, record });
    await record('result', result);
    console.log(`Buzz TestFlight operation: ${result.status}. Protected input and API responses omitted.`);
  } catch (error) {
    const code = /^[A-Z0-9_]+$/.test(error.message ?? '') ? error.message : 'OPERATION_FAILED';
    await record('failure', { status: code, ...(error.apple ? { apple: error.apple } : {}) });
    throw new Error(code);
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { await main(); } catch { console.error('Buzz TestFlight operation failed; see redacted receipt.'); process.exitCode = 1; }
}
