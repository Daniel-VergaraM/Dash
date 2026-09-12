import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { noteName, macFromArp, taskWindow, startOfDay } from './lib.js';
import {
  CAPABILITIES, ROLES, PASSWORD_MIN, capsOf, allows, validPassword, normalizeMac, cleanName,
  cleanPermissions, cleanTimezone, hashPassword, verifyPassword, initAuth, createUser, updateUser,
  deleteUser, signIn, userByMac, userByName, getUser, startSession, sessionUser, endSession,
  listUsers, lockedFor, recordFailure, clearFailures,
  addPasskey, removePasskey, passkeysOf, userByPasskey, touchPasskey,
} from './auth.js';
import { initTaskMeta, subtasksOf, setSubtasks, deleteSubtasksFor } from './task-meta.js';

/* ---------- lib ---------- */

// noteName is a trust boundary — it turns user input into a filesystem path.
assert.equal(noteName('ideas.md'), 'ideas.md');
assert.equal(noteName('my note (2).md'), 'my note (2).md');
for (const bad of ['../../etc/passwd', '..\\win.ini', 'x.md/../y', 'no-extension', '.hidden.md', '']) {
  assert.throws(() => noteName(bad), /bad note name/, `should reject ${bad}`);
}
assert.throws(() => noteName('/etc/passwd.md/..'), /bad note name/);
assert.equal(noteName('/tmp/deep/ok.md'), 'ok.md');

const win = ['Interface: 192.168.1.20 --- 0x5', '  Internet Address      Physical Address      Type',
  '  192.168.1.1           aa-bb-cc-dd-ee-01     dynamic',
  '  192.168.1.55          aa-bb-cc-dd-ee-02     dynamic'].join('\r\n');
assert.equal(macFromArp(win, '192.168.1.55'), 'aa:bb:cc:dd:ee:02');
assert.equal(macFromArp(win, '192.168.1.5'), null, 'must not match on prefix');
assert.equal(macFromArp('router (192.168.1.1) at aa:bb:cc:dd:ee:01 on en0', '192.168.1.1'), 'aa:bb:cc:dd:ee:01');
assert.equal(macFromArp('', '192.168.1.1'), null);

const w = taskWindow('2026-09-07T10:00:00.000Z', 45);
assert.equal(w.end, '2026-09-07T10:45:00.000Z');
assert.equal(taskWindow('2026-09-07T10:00:00.000Z').end, '2026-09-07T10:30:00.000Z');
assert.equal(taskWindow('2026-09-07T10:00:00.000Z', 1).end, '2026-09-07T10:05:00.000Z');
assert.equal(taskWindow('2026-09-07T10:00:00.000Z', 99999).end, '2026-09-08T10:00:00.000Z');
assert.throws(() => taskWindow('not a date', 30), /bad start time/);

// Naive "no timezone" strings — a raw <input type="datetime-local"> value — are interpreted in
// the given IANA zone rather than the server's own, once a user has one configured.
assert.equal(taskWindow('2026-06-01T09:00', 30, 'America/Mexico_City').start, '2026-06-01T15:00:00.000Z');
assert.equal(taskWindow('2026-06-01T09:00', 30, 'Asia/Tokyo').start, '2026-06-01T00:00:00.000Z');
// An already-absolute string is never reinterpreted, tz or not.
assert.equal(taskWindow('2026-06-01T09:00:00.000Z', 30, 'Asia/Tokyo').start, '2026-06-01T09:00:00.000Z');

// Midnight in Tokyo (UTC+9) on 2026-06-01 is 2026-05-31T15:00:00.000Z.
assert.equal(startOfDay('Asia/Tokyo', new Date('2026-06-01T10:00:00.000Z')).toISOString(), '2026-05-31T15:00:00.000Z');
// No tz falls back to the process's own local midnight — today's exact prior behavior.
{
  const now = new Date('2026-06-01T10:00:00.000Z');
  const want = new Date(now); want.setHours(0, 0, 0, 0);
  assert.equal(startOfDay(undefined, now).getTime(), want.getTime());
}

assert.equal(cleanTimezone('America/Mexico_City'), 'America/Mexico_City');
assert.equal(cleanTimezone('Not/AZone'), null);
assert.equal(cleanTimezone(null), null);
assert.equal(cleanTimezone(42), null);

/* ---------- input cleaning ---------- */

assert.equal(PASSWORD_MIN, 10);
for (const ok of ['correct horse battery', 'a'.repeat(10), 'a'.repeat(200)]) assert.ok(validPassword(ok));
for (const bad of ['short', 'a'.repeat(9), 'a'.repeat(201), '', null, undefined, 1234567890]) {
  assert.equal(validPassword(bad), false, `should reject password ${JSON.stringify(bad)}`);
}

assert.equal(normalizeMac('AA-BB-CC-DD-EE-FF'), 'aa:bb:cc:dd:ee:ff');
assert.equal(normalizeMac('aabbccddeeff'), 'aa:bb:cc:dd:ee:ff');
assert.equal(normalizeMac('aa:bb:cc:dd:ee'), null);
assert.equal(normalizeMac('nonsense'), null);

assert.equal(cleanName('  Ana   María  '), 'Ana María');
assert.equal(cleanName('x'), null);
assert.equal(cleanName('a'.repeat(200)).length, 40);

// Unknown capabilities are dropped rather than trusted.
assert.deepEqual(cleanPermissions(['notes:read', 'root:everything']), ['notes:read']);
assert.equal(cleanPermissions(null), null, 'null means inherit from role');
assert.equal(cleanPermissions('notes:read'), null, 'a non-array is not a permission set');

/* ---------- roles and capabilities ---------- */

assert.ok(ROLES.admin.includes('users:manage'));
assert.ok(!ROLES.member.includes('users:manage'), 'members must not manage access');
assert.ok(!ROLES.guest.some((c) => c.endsWith(':write') || c.endsWith(':manage')), 'guests are read-only');
assert.equal(ROLES.admin.length, Object.keys(CAPABILITIES).length);
assert.ok(!ROLES.member.includes('projects:write') && !ROLES.member.includes('projects:read'), 'projects are admin-only by default');
assert.ok(!ROLES.member.includes('github:read'), 'github is admin-only by default');
assert.ok(!ROLES.guest.includes('projects:read') && !ROLES.guest.includes('github:read'));
assert.deepEqual(capsOf({ role: 'admin', permissions: ['projects:read'] }), ['projects:read'], 'per-person override still grants an admin-only cap');

assert.deepEqual(capsOf({ role: 'guest' }), ROLES.guest);
assert.deepEqual(capsOf({ role: 'admin', permissions: ['notes:read'] }), ['notes:read'], 'override beats role');
assert.deepEqual(capsOf({ role: 'admin', disabled: true }), [], 'suspended people hold nothing');
assert.deepEqual(capsOf(null), []);
assert.ok(allows({ role: 'member' }, 'notes:write'));
assert.ok(allows({ role: 'guest' }, 'notes:write', 'notes:read'), 'any-of semantics');
assert.ok(!allows({ role: 'guest' }, 'notes:write'));

/* ---------- password hashing ---------- */

const PW = 'correct horse battery staple';
const h = await hashPassword(PW);
assert.ok(h.startsWith('scrypt:'));
assert.ok(!h.includes(PW), 'the password must never appear in its own hash');
assert.notEqual(h, await hashPassword(PW), 'salting makes two hashes of one password differ');
assert.ok(await verifyPassword(PW, h));
assert.ok(!(await verifyPassword(PW + 'x', h)));
assert.ok(!(await verifyPassword(PW, 'garbage')));
assert.ok(!(await verifyPassword(PW, null)));
await assert.rejects(() => hashPassword('short'), /at least 10/);

/* ---------- the store, end to end ---------- */

const OWNER_PW = 'owner passphrase one';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dash-auth-'));
await initAuth(dir, OWNER_PW);

const owner = await signIn('Owner', OWNER_PW);
assert.ok(owner, 'bootstrap admin signs in with the ACCESS_PASSWORD');
assert.equal(owner.role, 'admin');
assert.equal(listUsers()[0].passwordHash, undefined, 'hashes must never leave the module');
assert.equal(listUsers()[0].hasPassword, true);

// Names identify the account, so the lookup is case-insensitive but must stay unique.
assert.equal(userByName('owner').id, owner.id);
assert.equal(await signIn('OWNER', OWNER_PW).then((u) => u.id), owner.id);
await assert.rejects(() => createUser({ name: 'owner', password: 'another passphrase' }),
  /already has that name/);

const GUEST_PW = 'guest passphrase two';
const guest = await createUser({
  name: 'Guest', role: 'guest', password: GUEST_PW, macs: ['AA-BB-CC-DD-EE-01'],
});
assert.deepEqual(guest.macs, ['aa:bb:cc:dd:ee:01']);
assert.equal(guest.timezone, null, 'unset by default');
await updateUser(guest.id, { timezone: 'Europe/Madrid' });
assert.equal(getUser(guest.id).timezone, 'Europe/Madrid');
await updateUser(guest.id, { timezone: 'Not/AZone' });
assert.equal(getUser(guest.id).timezone, null, 'an invalid zone clears rather than sticking');
await updateUser(guest.id, { timezone: null });
assert.equal((await signIn('Guest', GUEST_PW)).id, guest.id);
assert.equal(await signIn('Guest', 'wrong passphrase here'), null);
assert.equal(await signIn('Nobody', GUEST_PW), null, 'an unknown name must not sign anyone in');
assert.equal(userByMac('aa:bb:cc:dd:ee:01').id, guest.id);
assert.equal(userByMac('ff:ff:ff:ff:ff:ff'), null);
await assert.rejects(() => createUser({ name: 'Ghost', role: 'guest' }), /needs a password/);
await assert.rejects(() => createUser({ name: 'Bad', role: 'wizard', password: PW }), /unknown role/);
await assert.rejects(() => createUser({ name: 'Weak', password: 'short' }), /at least 10/);

/* ---------- passkeys ---------- */

const KEY = { id: 'cred-aaa', publicKey: 'cHVia2V5', counter: 0, transports: ['internal'], label: 'Phone' };
await addPasskey(guest.id, KEY);
assert.equal(passkeysOf(guest.id).length, 1);
assert.equal(userByPasskey('cred-aaa').user.id, guest.id);
assert.equal(userByPasskey('cred-nope'), null);
await assert.rejects(() => addPasskey(guest.id, KEY), /already registered/);

// The public key never leaves the module with the rest of the record.
assert.equal(listUsers().find((u) => u.id === guest.id).passkeys[0].publicKey, undefined);
assert.equal(listUsers().find((u) => u.id === guest.id).passkeys[0].label, 'Phone');

// The counter is what detects a cloned authenticator later, so it has to be stored.
await touchPasskey('cred-aaa', 7);
assert.equal(passkeysOf(guest.id)[0].counter, 7);
assert.ok(passkeysOf(guest.id)[0].lastUsed);

// A suspended person's passkey must not resolve.
await updateUser(guest.id, { disabled: true });
assert.equal(userByPasskey('cred-aaa'), null, 'a suspended person cannot sign in with a passkey');
await updateUser(guest.id, { disabled: false });

// A passkey alone is a valid way in, so the password and the device may both be dropped...
await updateUser(guest.id, { clearPassword: true, macs: [] });
assert.equal(await signIn('Guest', GUEST_PW), null, 'a cleared password stops working');
assert.equal(userByMac('aa:bb:cc:dd:ee:01'), null, 'and the device no longer resolves');
// ...but then it is the only one left, and removing it would lock the account out.
await assert.rejects(() => removePasskey(guest.id, 'cred-aaa'), /only way in/);
assert.equal(passkeysOf(guest.id).length, 1, 'a rejected removal must leave the passkey in place');
await assert.rejects(() => removePasskey(guest.id, 'cred-nope'), /no such passkey/);

await updateUser(guest.id, { password: GUEST_PW });
await removePasskey(guest.id, 'cred-aaa');
assert.equal(passkeysOf(guest.id).length, 0);

/* ---------- sessions ---------- */

const sid = await startSession(guest, 'password', '10.0.0.9');
assert.equal(sessionUser(sid).user.id, guest.id);
await updateUser(guest.id, { disabled: true });
assert.equal(sessionUser(sid), null, 'suspending must invalidate live sessions');
assert.equal(await signIn('Guest', GUEST_PW), null, 'a suspended person cannot sign in');
await updateUser(guest.id, { disabled: false });

const sid2 = await startSession(guest, 'passkey', '10.0.0.9');
await endSession(sid2);
assert.equal(sessionUser(sid2), null);

/* ---------- the last-admin guard ---------- */

await assert.rejects(() => updateUser(owner.id, { role: 'guest' }), /nobody able to manage access/);
assert.equal(owner.role, 'admin', 'a rejected edit must leave nothing half-applied');
await assert.rejects(() => updateUser(owner.id, { name: 'x' }), /2-40 characters/);
assert.equal(owner.name, 'Owner', 'a rejected edit must not rename either');
await assert.rejects(() => deleteUser(owner.id), /nobody able to manage access/);
await deleteUser(guest.id);
assert.equal(listUsers().length, 1);

// Rotating a password invalidates the old one.
const NEW_PW = 'owner passphrase three';
await updateUser(owner.id, { password: NEW_PW });
assert.equal(await signIn('Owner', OWNER_PW), null);
assert.equal((await signIn('Owner', NEW_PW)).id, owner.id);

/* ---------- rate limiting ---------- */

const ip = '10.0.0.42';
assert.equal(lockedFor(ip), 0);
for (let i = 0; i < 5; i++) recordFailure(ip);
assert.ok(lockedFor(ip) > 0, 'five failures locks the address out');
clearFailures(ip);
assert.equal(lockedFor(ip), 0);

/* ---------- persistence ---------- */

await initAuth(dir, OWNER_PW);
assert.equal(listUsers().length, 1, 'a second init must not create another bootstrap admin');
assert.equal((await signIn('Owner', NEW_PW)).id, owner.id);

await fs.rm(dir, { recursive: true, force: true });

/* ---------- migration from the old 6-digit codes ---------- */

// Records written before the switch stored the hash under `codeHash`. scrypt does not care
// what the input was, so the old credential has to keep working after the rename.
const legacyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dash-legacy-'));
await fs.writeFile(path.join(legacyDir, 'auth.json'), JSON.stringify({
  users: [{
    id: 'u_legacy', name: 'Old', role: 'admin', permissions: null, macs: [],
    codeHash: await hashPassword('424242 was a code'), disabled: false, createdAt: 1, lastSeen: null,
  }],
  sessions: {},
}));
await initAuth(legacyDir, OWNER_PW);
assert.equal(listUsers().length, 1, 'the migrated admin counts, so no bootstrap admin is added');
assert.ok(await signIn('Old', '424242 was a code'), 'the old credential still opens the account');
assert.equal(getUser('u_legacy').codeHash, undefined, 'codeHash is gone once migrated');
assert.deepEqual(passkeysOf('u_legacy'), [], 'older records gain an empty passkey list');
await fs.rm(legacyDir, { recursive: true, force: true });

/* ---------- subtasks store, end to end ---------- */

const tmDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dash-taskmeta-'));
await initTaskMeta(tmDir);
assert.deepEqual(subtasksOf('evt1'), []);

const list = await setSubtasks('evt1', [{ title: 'Buy tiles' }, { title: 'Call plumber', done: true }]);
assert.equal(list.length, 2);
assert.ok(list[0].id.startsWith('s_'));
assert.equal(subtasksOf('evt1').length, 2);

const capped = await setSubtasks('evt1', Array.from({ length: 60 }, (_, i) => ({ title: 'item ' + i })));
assert.equal(capped.length, 50, 'subtask lists are capped at 50');

await setSubtasks('evt1', []);
assert.deepEqual(subtasksOf('evt1'), [], 'an empty list clears the entry entirely');

await setSubtasks('evt2', [{ title: 'solo' }]);
await deleteSubtasksFor('evt2');
assert.deepEqual(subtasksOf('evt2'), []);

await initTaskMeta(tmDir); // persistence round-trip does not crash on an empty store
assert.deepEqual(subtasksOf('evt1'), []);

await fs.rm(tmDir, { recursive: true, force: true });

console.log('ok');
