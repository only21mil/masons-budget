import test from 'node:test';
import assert from 'node:assert/strict';
import { APP, BUILD, client, operate, internalAccess } from '../buzz_testflight_recipient.mjs';
const EMAIL = 'fixture@example.test';
const GROUP = '11111111-1111-1111-1111-111111111111';
const TESTER = '22222222-2222-2222-2222-222222222222';
function fixture({ internal = false, publicLink = false, allBuilds = false, other = false, member = true, assigned = true,
  state = 'INVITED', beta = 'IN_BETA_TESTING', otherBuild = false, otherIndividual = false, notificationActivates = true, groupName = 'Buzz private beta' } = {}) {
  const writes = [];
  const api = async (path, method = 'GET', body) => {
    const url = new URL(path, 'https://api.appstoreconnect.apple.com');
    if (method !== 'GET') {
      writes.push({ path: url.pathname, method, body });
      if (url.pathname.endsWith('/relationships/builds')) assigned = true;
      else if (url.pathname.endsWith('/relationships/betaTesters')) member = true;
      else if (url.pathname === '/v1/betaTesterInvitations') { state = 'INVITED'; return { data: { type: 'betaTesterInvitations', id: 'receipt' } }; }
      else if (url.pathname === '/v1/buildBetaNotifications') { if (notificationActivates) beta = 'IN_BETA_TESTING'; return { data: { type: 'buildBetaNotifications' } }; }
      else throw new Error('UNEXPECTED_MUTATION');
      return {};
    }
    const p = url.pathname;
    if (p === '/v1/users') return { data: [{ type: 'users', id: 'fixture-user', attributes: { username: EMAIL, roles: ['MARKETING'], allAppsVisible: true } }] };
    if (p.endsWith('/betaAppReviewDetail')) return { data: { attributes: { contactFirstName: EMAIL, contactLastName: EMAIL, contactPhone: EMAIL, contactEmail: EMAIL, demoAccountRequired: false } } };
    if (p.endsWith('/betaAppLocalizations')) return { data: [{ attributes: { description: EMAIL, feedbackEmail: EMAIL, locale: 'en-US' } }] };
    if (p.endsWith('/betaBuildLocalizations')) return { data: [{ attributes: { whatsNew: EMAIL, locale: 'en-US' } }] };
    if (p === `/v1/apps/${APP}` || p.endsWith('/app')) return { data: { id: APP, type: 'apps', attributes: { bundleId: 'com.sats21m.buzz' } } };
    if (p === `/v1/builds/${BUILD}`) return { data: { id: BUILD, type: 'builds', attributes: { version: '1', processingState: 'VALID', expired: false } } };
    if (p.endsWith('/preReleaseVersion')) return { data: { attributes: { version: '0.5.9', platform: 'IOS' } } };
    if (p.endsWith('/buildBetaDetail')) return { data: { type: 'buildBetaDetails', attributes: { internalBuildState: beta, externalBuildState: beta } } };
    if (p === '/v1/betaTesters') return { data: [{ id: TESTER, type: 'betaTesters', attributes: { email: EMAIL, state } }] };
    if (p === '/v1/betaGroups') return { data: [{ id: GROUP, type: 'betaGroups', attributes: { name: groupName, isInternalGroup: internal, publicLinkEnabled: publicLink, hasAccessToAllBuilds: allBuilds } }] };
    if (p.endsWith('/relationships/betaTesters')) return { data: [...(member ? [{ id: TESTER }] : []), ...(other ? [{ id: 'other' }] : [])] };
    if (p.endsWith('/relationships/builds')) return { data: [...(assigned ? [{ id: BUILD }] : []), ...(otherBuild ? [{ id: 'other-build' }] : [])] };
    if (p.endsWith('/relationships/individualTesters')) return { data: otherIndividual ? [{ id: 'other-tester' }] : [] };
    throw new Error('UNEXPECTED_READ');
  };
  return { api, writes };
}
test('inventory performs no mutations and contains no recipient email', async () => {
  const { api, writes } = fixture();
  const result = await operate({ api, email: EMAIL, action: 'inventory' });
  assert.equal(result.status, 'INVENTORY_ONLY'); assert.deepEqual(writes, []);
  assert.equal(JSON.stringify(result).includes(EMAIL), false);
});
test('existing membership and invitation are idempotent', async () => {
  const { api, writes } = fixture();
  const result = await operate({ api, email: EMAIL, action: 'distribute', groupId: GROUP });
  assert.equal(result.status, 'DISTRIBUTED'); assert.deepEqual(writes, []);
});
test('ready NOT_INVITED recipient sends exactly once then reads back', async () => {
  const { api, writes } = fixture({ state: 'NOT_INVITED' });
  const result = await operate({ api, email: EMAIL, action: 'distribute', groupId: GROUP });
  assert.equal(result.invitation, 'PROVIDER_ACCEPTED'); assert.equal(result.recipient_state, 'INVITED');
  assert.equal(writes.length, 1); assert.equal(writes[0].path, '/v1/betaTesterInvitations');
});
test('unrelated testers block new build assignment', async () => {
  const { api, writes } = fixture({ other: true, assigned: false });
  await assert.rejects(operate({ api, email: EMAIL, action: 'distribute', groupId: GROUP }), /BUILD_WOULD_REACH_OTHER_TESTERS/);
  assert.deepEqual(writes, []);
});
test('qualified existing internal user can join only the selected build group', async () => {
  const { api, writes } = fixture({ internal: true, member: false });
  const result = await operate({ api, email: EMAIL, action: 'distribute', groupId: GROUP });
  assert.equal(result.status, 'DISTRIBUTED');
  assert.deepEqual(writes.map(item => item.path), [`/v1/betaGroups/${GROUP}/relationships/betaTesters`]);
});
test('public link group cannot receive private recipient', async () => {
  const { api, writes } = fixture({ publicLink: true });
  await assert.rejects(operate({ api, email: EMAIL, action: 'distribute', groupId: GROUP }), /GROUP_NOT_PRIVATE_AND_SCOPED/);
  assert.deepEqual(writes, []);
});
test('Apple review wait is honest and sends no invitation', async () => {
  const { api, writes } = fixture({ beta: 'WAITING_FOR_BETA_REVIEW', state: 'NOT_INVITED' });
  const result = await operate({ api, email: EMAIL, action: 'distribute', groupId: GROUP });
  assert.equal(result.status, 'APPLE_BETA_READINESS_PENDING'); assert.equal(result.build_available, false);
  assert.deepEqual(writes, []);
});
test('transport rejects foreign pagination and does not retry mutations', async () => {
  let count = 0;
  const api = client(() => 'fixture-token', async () => { count++; throw new Error('network failure'); });
  await assert.rejects(api('https://foreign.example/v1/test'));
  assert.equal(count, 0);
  await assert.rejects(api('/v1/betaTesters', 'POST', {})); assert.equal(count, 1);
});

test('private group names never enter inventory receipts', async () => {
  const { api } = fixture({ groupName: EMAIL });
  const result = await operate({ api, email: EMAIL, action: 'inventory' });
  assert.equal(JSON.stringify(result).includes(EMAIL), false);
});
test('new membership cannot grant other builds', async () => {
  const { api, writes } = fixture({ member: false, otherBuild: true });
  await assert.rejects(operate({ api, email: EMAIL, action: 'distribute', groupId: GROUP }), /MEMBERSHIP_WOULD_GRANT_OTHER_BUILDS/);
  assert.deepEqual(writes, []);
});
test('ready build needs notification and observed active testing', async () => {
  const { api, writes } = fixture({ beta: 'READY_FOR_BETA_TESTING' });
  const result = await operate({ api, email: EMAIL, action: 'distribute', groupId: GROUP });
  assert.equal(result.build_available, true); assert.equal(result.external_state, 'IN_BETA_TESTING');
  assert.equal(writes.length, 1); assert.equal(writes[0].path, '/v1/buildBetaNotifications');
});
test('notification accepted without active readback stays pending', async () => {
  const { api } = fixture({ beta: 'READY_FOR_BETA_TESTING', notificationActivates: false });
  const result = await operate({ api, email: EMAIL, action: 'distribute', groupId: GROUP });
  assert.equal(result.build_available, false); assert.equal(result.status, 'APPLE_BETA_READINESS_PENDING');
});
test('build-wide notification refuses unrelated individual testers', async () => {
  const { api, writes } = fixture({ beta: 'READY_FOR_BETA_TESTING', otherIndividual: true });
  await assert.rejects(operate({ api, email: EMAIL, action: 'distribute', groupId: GROUP }), /NOTIFICATION_WOULD_REACH_OTHER_TESTERS/);
  assert.deepEqual(writes, []);
});
test('Apple error diagnostics omit details, titles and unsafe pointers', async () => {
  const api = client(() => 'token', async () => ({ ok: false, status: 409, text: async () => JSON.stringify({ errors: [
    { code: 'ENTITY_ERROR.REQUIRED', title: EMAIL, detail: EMAIL, source: { pointer: '/data/attributes/description' } },
    { code: EMAIL, source: { pointer: '/data/' + EMAIL } },
  ] }) }));
  await assert.rejects(api('/v1/betaGroups'), error => {
    assert.equal(error.message, 'APPLE_HTTP_409'); assert.equal(JSON.stringify(error.apple).includes(EMAIL), false);
    assert.equal(error.apple[0].pointer, '/data/attributes/description'); return true;
  });
});

test('metadata inventory reports presence without contact or description values', async () => {
  const { api } = fixture();
  const result = await operate({ api, email: EMAIL, action: 'inventory' });
  assert.equal(result.beta_metadata.review_detail_exists, true);
  assert.deepEqual(result.beta_metadata.missing_contact_fields, []);
  assert.equal(result.beta_metadata.build_test_notes_present, true);
  assert.equal(JSON.stringify(result).includes(EMAIL), false);
});
test('absent beta review detail is reported and submission refuses missing metadata', async () => {
  const base = fixture({ beta: 'READY_FOR_BETA_SUBMISSION' });
  const api = async (path, ...args) => {
    if (new URL(path, 'https://api.appstoreconnect.apple.com').pathname.endsWith('/betaAppReviewDetail')) throw new Error('APPLE_HTTP_404');
    return base.api(path, ...args);
  };
  const result = await operate({ api, email: EMAIL, action: 'inventory' });
  assert.equal(result.beta_metadata.review_detail_exists, false);
  assert.equal(result.beta_metadata.missing_contact_fields.length, 4);
  const pending = await operate({ api, email: EMAIL, action: 'distribute', groupId: GROUP });
  assert.equal(pending.status, 'BETA_REVIEW_METADATA_REQUIRED');
  assert.equal(pending.build_available, false);
  assert.equal(pending.groups[0].recipient_member, true);
  assert.deepEqual(base.writes, []);
});

test('metadata action rejects incomplete credentials and arbitrary sections before writes', async () => {
  for (const metadata of [{ review_detail: { demoAccountPassword: 'fixture' } }, { review_detail: { demoAccountRequired: true } }, { arbitrary: 'fixture' }, { review_detail: null }]) {
    const { api, writes } = fixture();
    await assert.rejects(operate({ api, email: EMAIL, action: 'metadata', metadata }));
    assert.deepEqual(writes, []);
  }
});
test('review contact update uses current app resource, verifies exact values and is idempotent', async () => {
  const base = fixture();
  const detail = { type: 'betaAppReviewDetails', id: APP, attributes: {
    contactFirstName: 'Prior', contactLastName: 'Fixture', contactEmail: EMAIL, contactPhone: '+15555555555', demoAccountRequired: false,
  } };
  const writes = [];
  const api = async (path, method = 'GET', body) => {
    const url = new URL(path, 'https://api.appstoreconnect.apple.com');
    if (url.pathname.endsWith('/betaAppReviewDetail') || url.pathname === '/v1/betaAppReviewDetails/' + detail.id) {
      if (method === 'PATCH') { writes.push(body); Object.assign(detail.attributes, body.data.attributes); }
      return { data: detail };
    }
    return base.api(path, method, body);
  };
  const metadata = { review_detail: { contactFirstName: 'Updated' } };
  const result = await operate({ api, email: EMAIL, action: 'metadata', metadata });
  assert.equal(result.status, 'METADATA_UPDATED'); assert.equal(writes.length, 1);
  assert.equal(writes[0].data.id, detail.id); assert.equal(detail.attributes.contactFirstName, 'Updated');
  assert.equal(JSON.stringify(result).includes('Updated'), false);
  await operate({ api, email: EMAIL, action: 'metadata', metadata }); assert.equal(writes.length, 1);
});

test('metadata PATCH response cannot rebind the selected opaque resource ID', async () => {
  const base = fixture();
  const api = async (path, method = 'GET', body) => {
    const p = new URL(path, 'https://api.appstoreconnect.apple.com').pathname;
    if (p.endsWith('/betaAppReviewDetail')) return { data: { type: 'betaAppReviewDetails', id: APP, attributes: { contactFirstName: 'Prior' } } };
    if (method === 'PATCH') return { data: { ...body.data, id: APP + '1' } };
    return base.api(path, method, body);
  };
  await assert.rejects(operate({ api, email: EMAIL, action: 'metadata', metadata: { review_detail: { contactFirstName: 'Updated' } } }), /INVALID_METADATA_WRITE_RECEIPT/);
});

// Sanitized structural readback from run 34261330765 after group creation.
// Apple returned null for hasAccessToAllBuilds on an empty external group.
for (const groupId of [GROUP, 'new-private']) {
  test(`external null group resumes empty-group setup via ${groupId}`, async () => {
    const base = fixture({ allBuilds: null, member: false, assigned: false, beta: 'READY_FOR_BETA_SUBMISSION' });
    let created = false;
    const writes = [];
    const api = async (path, method = 'GET', body) => {
      const p = new URL(path, 'https://api.appstoreconnect.apple.com').pathname;
      if (method !== 'GET') writes.push({ path: p, method, body });
      if (p === '/v1/betaTesters') {
        if (method === 'POST') {
          created = true;
          return { data: { type: 'betaTesters', id: TESTER } };
        }
        return { data: created ? [{ type: 'betaTesters', id: TESTER, attributes: { email: EMAIL, state: 'NOT_INVITED' } }] : [] };
      }
      if (p.endsWith('/relationships/betaTesters')) return { data: created ? [{ id: TESTER }] : [] };
      if (p.endsWith('/betaAppReviewDetail')) return { data: { attributes: { demoAccountRequired: null } } };
      if (p.endsWith('/betaAppLocalizations') || p.endsWith('/betaBuildLocalizations')) return { data: [] };
      return base.api(path, method, body);
    };
    const result = await operate({ api, email: EMAIL, action: 'distribute', groupId });
    assert.equal(result.status, 'BETA_REVIEW_METADATA_REQUIRED');
    assert.equal(result.selected_group, GROUP);
    assert.equal(result.build_available, false);
    assert.equal(result.invitation, 'NOT_SENT_BUILD_UNAVAILABLE');
    assert.equal(result.groups[0].all_builds, null);
    assert.equal(result.groups[0].recipient_member, true);
    assert.equal(result.groups[0].build_member, true);
    assert.deepEqual(writes, [
      { path: `/v1/betaGroups/${GROUP}/relationships/builds`, method: 'POST', body: { data: [{ type: 'builds', id: BUILD }] } },
      { path: '/v1/betaTesters', method: 'POST', body: { data: { type: 'betaTesters', attributes: { email: EMAIL },
        relationships: { betaGroups: { data: [{ type: 'betaGroups', id: GROUP }] } } } } },
    ]);
    assert.equal(JSON.stringify(result).includes(EMAIL), false);
    await operate({ api, email: EMAIL, action: 'distribute', groupId });
    assert.equal(writes.length, 2, 'retry must reuse group, build and recipient');
  });
}
for (const [label, options, code] of [
  ['internal null', { internal: true, allBuilds: null }, 'GROUP_NOT_PRIVATE_AND_SCOPED'],
  ['external all builds', { allBuilds: true }, 'GROUP_NOT_PRIVATE_AND_SCOPED'],
  ['internal all builds', { internal: true, allBuilds: true }, 'GROUP_NOT_PRIVATE_AND_SCOPED'],
  ['malformed all builds', { allBuilds: 'false' }, 'GROUP_NOT_PRIVATE_AND_SCOPED'],
  ['numeric all builds', { allBuilds: 0 }, 'GROUP_NOT_PRIVATE_AND_SCOPED'],
  ['external null public link', { allBuilds: null, publicLink: true }, 'GROUP_NOT_PRIVATE_AND_SCOPED'],
  ['external null with other builds', { allBuilds: null, member: false, otherBuild: true }, 'MEMBERSHIP_WOULD_GRANT_OTHER_BUILDS'],
  ['external null with other testers', { allBuilds: null, assigned: false, other: true }, 'BUILD_WOULD_REACH_OTHER_TESTERS'],
  ['external null with notification audience', { allBuilds: null, beta: 'READY_FOR_BETA_TESTING', otherIndividual: true }, 'NOTIFICATION_WOULD_REACH_OTHER_TESTERS'],
]) {
  test(`${label} still fails closed`, async () => {
    const { api, writes } = fixture(options);
    await assert.rejects(operate({ api, email: EMAIL, action: 'distribute', groupId: GROUP }), new RegExp(code));
    assert.deepEqual(writes, []);
  });
}
test('missing all-builds attribute still fails closed', async () => {
  const base = fixture();
  const api = async (path, ...args) => {
    const result = await base.api(path, ...args);
    if (new URL(path, 'https://api.appstoreconnect.apple.com').pathname === '/v1/betaGroups') {
      delete result.data[0].attributes.hasAccessToAllBuilds;
    }
    return result;
  };
  await assert.rejects(operate({ api, email: EMAIL, action: 'distribute', groupId: GROUP }), /GROUP_NOT_PRIVATE_AND_SCOPED/);
  assert.deepEqual(base.writes, []);
});

const PAIRING = 'buzz://' + Buffer.from(JSON.stringify({ relayUrl: 'https://buzz-review.only21mil.xyz', pubkey: 'a'.repeat(64), nsec: 'nsec1' + 'q'.repeat(58) })).toString('base64url');
for (const truncated of [false, true]) test(`private pairing update verifies full password, truncated=${truncated}`, async () => {
  const base = fixture();
  const detail = { type: 'betaAppReviewDetails', id: APP, attributes: { demoAccountRequired: false } };
  const writes = [], records = [];
  const api = async (path, method = 'GET', body) => {
    const p = new URL(path, 'https://api.appstoreconnect.apple.com').pathname;
    if (p.endsWith('/betaAppReviewDetail') || p === '/v1/betaAppReviewDetails/' + APP) {
      if (method === 'PATCH') { writes.push(body); Object.assign(detail.attributes, body.data.attributes); if (truncated) detail.attributes.demoAccountPassword = PAIRING.slice(0, 100); }
      return { data: detail };
    }
    return base.api(path, method, body);
  };
  const args = { api, email: EMAIL, action: 'metadata', metadata: { review_detail: { demoAccountRequired: true, demoAccountName: 'Apple reviewer', demoAccountPassword: PAIRING } }, record: async (name, value) => records.push({ name, value }) };
  if (truncated) await assert.rejects(operate(args), /METADATA_WRITE_READBACK_MISMATCH/);
  else {
    const result = await operate(args);
    assert.equal(result.status, 'METADATA_UPDATED');
    assert.equal(JSON.stringify(result).includes(PAIRING), false);
    await operate(args); // Exact input is idempotent.
  }
  assert.equal(writes.length, 1);
  assert.equal(writes[0].data.attributes.demoAccountPassword, PAIRING);
  assert.equal(JSON.stringify(records).includes(PAIRING), false);
});
test('private pairing rejects wrong deployment and malformed payload before writes', async () => {
  for (const password of ['buzz://e30', PAIRING.replace('buzz://', 'https://'), 'x'.repeat(4001), 'buzz://' + Buffer.from(JSON.stringify({ relayUrl: 'https://private.example', pubkey: 'a'.repeat(64), nsec: 'nsec1' + 'q'.repeat(58) })).toString('base64url')]) {
    const { api, writes } = fixture();
    await assert.rejects(operate({ api, email: EMAIL, action: 'metadata', metadata: { review_detail: { demoAccountRequired: true, demoAccountName: 'Apple reviewer', demoAccountPassword: password } } }));
    assert.deepEqual(writes, []);
  }
});

test('internal access checks exact identity, role and Buzz app visibility', async () => {
  const user = { type: 'users', id: 'fixture-user', attributes: { username: EMAIL, roles: ['MARKETING'], allAppsVisible: false } };
  let apps = [{ type: 'apps', id: APP, attributes: { bundleId: 'com.sats21m.buzz' } }];
  const api = async path => ({ data: new URL(path, 'https://fixture.test').pathname === '/v1/users' ? [user] : apps });
  assert.deepEqual(await internalAccess(api, EMAIL), { user_exists: true, eligible_role: true, app_visible: true });
  apps = [];
  assert.equal((await internalAccess(api, EMAIL)).app_visible, false);
  user.attributes.roles = ['SALES'];
  assert.equal((await internalAccess(api, EMAIL)).eligible_role, false);
  user.attributes.username = 'someoneelse@example.test';
  await assert.rejects(internalAccess(api, EMAIL), /ASC_USER_IDENTITY_MISMATCH/);
});

test('missing internal app access causes no group, membership or invitation mutation', async () => {
  const base = fixture({ internal: true });
  const api = async (path, ...args) => {
    const p = new URL(path, 'https://fixture.test').pathname;
    if (p === '/v1/users') return { data: [{ type: 'users', id: 'fixture-user', attributes: { username: EMAIL, roles: ['MARKETING'], allAppsVisible: false } }] };
    if (p.endsWith('/visibleApps')) return { data: [] };
    return base.api(path, ...args);
  };
  const result = await operate({ api, email: EMAIL, action: 'distribute', groupId: GROUP });
  assert.equal(result.status, 'INTERNAL_ASC_ACCESS_REQUIRED'); assert.deepEqual(base.writes, []);
});

test('new internal group uses only qualified user and retained build without beta review', async () => {
  const base = fixture({ internal: true, groupName: 'Buzz private internal beta' });
  let created = false;
  const api = async (path, method = 'GET', body) => {
    const p = new URL(path, 'https://fixture.test').pathname;
    if (p === '/v1/betaGroups' && method === 'GET' && !created) return { data: [] };
    if (p === '/v1/betaGroups' && method === 'POST') {
      assert.deepEqual(body.data.attributes, { name: 'Buzz private internal beta', isInternalGroup: true, publicLinkEnabled: false, hasAccessToAllBuilds: false });
      assert.deepEqual(body.data.relationships, { app: { data: { type: 'apps', id: APP } } });
      created = true; return { data: { type: 'betaGroups', id: GROUP } };
    }
    return base.api(path, method, body);
  };
  const result = await operate({ api, email: EMAIL, action: 'distribute', groupId: 'new-internal' });
  assert.equal(result.status, 'DISTRIBUTED'); assert.equal(created, true); assert.deepEqual(base.writes, []);
});

test('absent ASC user gets one Buzz-only Marketing invitation then acceptance hold', async () => {
  const base = fixture(); let invitation; const writes = [];
  const api = async (path, method = 'GET', body) => {
    const p = new URL(path, 'https://fixture.test').pathname;
    if (p === '/v1/users') return { data: [] };
    if (p === '/v1/userInvitations' && method === 'GET') return { data: invitation ? [invitation] : [] };
    if (p === '/v1/userInvitations' && method === 'POST') {
      writes.push(body); invitation = { ...body.data, id: 'invitation-id' }; return { data: invitation };
    }
    if (p === '/v1/userInvitations/invitation-id') return { data: invitation };
    if (p === '/v1/userInvitations/invitation-id/visibleApps') return { data: [{ type: 'apps', id: APP }] };
    return base.api(path, method, body);
  };
  const args = { api, email: EMAIL, action: 'distribute', groupId: 'new-internal', metadata: { internal_user: { firstName: 'Fixture', lastName: 'Tester' } } };
  const result = await operate(args);
  assert.equal(result.status, 'ASC_INVITATION_SENT_REQUIRES_ACCEPTANCE');
  assert.equal(result.build_available, false); assert.equal(JSON.stringify(result).includes(EMAIL), false);
  assert.deepEqual(writes[0].data.attributes, { email: EMAIL, firstName: 'Fixture', lastName: 'Tester', roles: ['MARKETING'], allAppsVisible: false, provisioningAllowed: false });
  assert.deepEqual(writes[0].data.relationships, { visibleApps: { data: [{ type: 'apps', id: APP }] } });
  assert.equal((await operate(args)).status, 'EXISTING_ASC_INVITATION_REQUIRES_ACCEPTANCE');
  assert.equal(writes.length, 1); assert.deepEqual(base.writes, []);
});

test('absent ASC user cannot be invited without explicit private name input', async () => {
  const base = fixture();
  const api = async (path, ...args) => ['/v1/users', '/v1/userInvitations'].includes(new URL(path, 'https://fixture.test').pathname) ? { data: [] } : base.api(path, ...args);
  await assert.rejects(operate({ api, email: EMAIL, action: 'distribute', groupId: 'new-internal' }), /INTERNAL_USER_NAME_REQUIRED/);
  assert.deepEqual(base.writes, []);
});

test('tester lookup scopes repeated email records to the fixed Buzz app', async () => {
  const base = fixture();
  const api = async (path, ...args) => {
    const url = new URL(path, 'https://fixture.test');
    if (url.pathname === '/v1/betaTesters') {
      assert.equal(url.searchParams.get('filter[email]'), EMAIL);
      if (url.searchParams.get('filter[apps]') !== APP) return { data: [
        { type: 'betaTesters', id: TESTER, attributes: { email: EMAIL, state: 'INVITED' } },
        { type: 'betaTesters', id: GROUP, attributes: { email: EMAIL, state: 'INSTALLED' } },
      ] };
      return base.api(path, ...args);
    }
    return base.api(path, ...args);
  };
  const result = await operate({ api, email: EMAIL, action: 'inventory' });
  assert.equal(result.recipient_exists, true); assert.deepEqual(base.writes, []);
});

test('same-app ambiguity still refuses while retaining independent ASC access readback', async () => {
  const base = fixture(); const records = [];
  const api = async (path, ...args) => new URL(path, 'https://fixture.test').pathname === '/v1/betaTesters'
    ? { data: [{ id: TESTER }, { id: GROUP }] } : base.api(path, ...args);
  await assert.rejects(operate({ api, email: EMAIL, action: 'inventory', record: async (name, value) => records.push({ name, value }) }), /AMBIGUOUS_RECIPIENT/);
  assert.deepEqual(records, [{ name: 'internal-access', value: { user_exists: true, eligible_role: true, app_visible: true } }]);
  assert.deepEqual(base.writes, []);
});

test('first Buzz access adds only Buzz and preserves existing apps and role', async () => {
  const user = { type: 'users', id: 'fixture-user', attributes: { username: EMAIL, roles: ['MARKETING'], allAppsVisible: false } };
  let apps = [{ type: 'apps', id: 'existing-app', attributes: { bundleId: 'existing.bundle' } }]; const writes = [];
  const api = async (path, method = 'GET', body) => {
    const p = new URL(path, 'https://fixture.test').pathname;
    if (method === 'POST') {
      assert.equal(p, '/v1/users/fixture-user/relationships/visibleApps');
      assert.deepEqual(body, { data: [{ type: 'apps', id: APP }] });
      writes.push(body); apps = [...apps, { type: 'apps', id: APP, attributes: { bundleId: 'com.sats21m.buzz' } }]; return {};
    }
    return { data: p === '/v1/users' ? [user] : p.endsWith('/visibleApps') ? apps : user };
  };
  assert.equal((await internalAccess(api, EMAIL)).app_visible, false); assert.equal(writes.length, 0);
  assert.deepEqual(await internalAccess(api, EMAIL, true), { user_exists: true, eligible_role: true, app_visible: true });
  assert.equal(writes.length, 1);
  await internalAccess(api, EMAIL, true); assert.equal(writes.length, 1);
});

test('Buzz visibility grant refuses ineligible roles and detects broadened readback', async () => {
  const user = { type: 'users', id: 'fixture-user', attributes: { username: EMAIL, roles: ['SALES'], allAppsVisible: false } };
  let writes = 0;
  const api = async (path, method = 'GET') => {
    const p = new URL(path, 'https://fixture.test').pathname;
    if (method === 'POST') { writes++; return {}; }
    if (p === '/v1/users') return { data: [user] };
    if (p.endsWith('/visibleApps')) return { data: [] };
    return { data: { ...user, attributes: { ...user.attributes, allAppsVisible: true } } };
  };
  assert.equal((await internalAccess(api, EMAIL, true)).eligible_role, false); assert.equal(writes, 0);
  user.attributes.roles = ['MARKETING'];
  await assert.rejects(internalAccess(api, EMAIL, true), /ASC_APP_ACCESS_READBACK_MISMATCH/);
  assert.equal(writes, 1);
});
