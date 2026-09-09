import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { noteName, macFromArp, taskWindow } from './lib.js';
import {
  CAPABILITIES, ROLES, capsOf, allows, validCode, normalizeMac, cleanName, cleanPermissions,
  hashCode, verifyCode, initAuth, createUser, updateUser, deleteUser, userByCode, userByMac,
  startSession, sessionUser, endSession, listUsers, lockedFor, recordFailure, clearFailures,
} from './auth.js';

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

/* ---------- input cleaning ---------- */

for (const ok of ['000000', '123456', '999999']) assert.ok(validCode(ok));
for (const bad of ['12345', '1234567', 'abcdef', '12 456', '', null, undefined, '12345\n']) {
  assert.equal(validCode(bad), false, `should reject code ${JSON.stringify(bad)}`);
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
assert.ok(ROLES.admin.length === Object.keys(CAPABILITIES).length);

assert.deepEqual(capsOf({ role: 'guest' }), ROLES.guest);
assert.deepEqual(capsOf({ role: 'admin', permissions: ['notes:read'] }), ['notes:read'], 'override beats role');
assert.deepEqual(capsOf({ role: 'admin', disabled: true }), [], 'suspended people hold nothing');
assert.deepEqual(capsOf(null), []);
assert.ok(allows({ role: 'member' }, 'notes:write'));
assert.ok(allows({ role: 'guest' }, 'notes:write', 'notes:read'), 'any-of semantics');
assert.ok(!allows({ role: 'guest' }, 'notes:write'));

/* ---------- code hashing ---------- */

const h = await hashCode('424242');
assert.ok(h.startsWith('scrypt:'));
assert.ok(!h.includes('424242'), 'the code must never appear in its own hash');
assert.notEqual(h, await hashCode('424242'), 'salting makes two hashes of one code differ');
assert.ok(await verifyCode('424242', h));
assert.ok(!(await verifyCode('424243', h)));
assert.ok(!(await verifyCode('424242', 'garbage')));
assert.ok(!(await verifyCode('424242', null)));
await assert.rejects(() => hashCode('abc'), /6 digits/);

/* ---------- the store, end to end ---------- */

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dash-auth-'));
await initAuth(dir, '111111');

const owner = await userByCode('111111');
assert.ok(owner, 'bootstrap admin signs in with the ACCESS_CODE');
assert.equal(owner.role, 'admin');
assert.equal(listUsers()[0].codeHash, undefined, 'hashes must never leave the module');

const guest = await createUser({ name: 'Guest', role: 'guest', code: '222222', macs: ['AA-BB-CC-DD-EE-01'] });
assert.deepEqual(guest.macs, ['aa:bb:cc:dd:ee:01']);
assert.equal((await userByCode('222222')).id, guest.id);
assert.equal(userByMac('aa:bb:cc:dd:ee:01').id, guest.id);
assert.equal(userByMac('ff:ff:ff:ff:ff:ff'), null);
assert.equal(await userByCode('999999'), null);
await assert.rejects(() => createUser({ name: 'Ghost', role: 'guest' }), /needs a code/);
await assert.rejects(() => createUser({ name: 'Bad', role: 'wizard', code: '333333' }), /unknown role/);

// Sessions survive independently of the code, and end when a person is suspended.
const sid = await startSession(guest, 'code', '10.0.0.9');
assert.equal(sessionUser(sid).user.id, guest.id);
await updateUser(guest.id, { disabled: true });
assert.equal(sessionUser(guest.id), null);
assert.equal(sessionUser(sid), null, 'suspending must invalidate live sessions');
assert.equal(userByCode('222222') instanceof Promise ? await userByCode('222222') : null, null,
  'a suspended person cannot sign in');
await updateUser(guest.id, { disabled: false });

const sid2 = await startSession(guest, 'device', '10.0.0.9');
await endSession(sid2);
assert.equal(sessionUser(sid2), null);

// The last route into the admin panel is protected from every angle.
await assert.rejects(() => updateUser(owner.id, { role: 'guest' }), /nobody able to manage access/);
assert.equal(owner.role, 'admin', 'a rejected edit must leave nothing half-applied');
await assert.rejects(() => updateUser(owner.id, { name: 'x' }), /2-40 characters/);
assert.equal(owner.name, 'Owner', 'a rejected edit must not rename either');
await assert.rejects(() => deleteUser(owner.id), /nobody able to manage access/);
await deleteUser(guest.id);
assert.equal(listUsers().length, 1);

// Rotating a code invalidates the old one.
await updateUser(owner.id, { code: '555555' });
assert.equal(await userByCode('111111'), null);
assert.equal((await userByCode('555555')).id, owner.id);

// Lockout escalates and clears.
const ip = '10.0.0.42';
assert.equal(lockedFor(ip), 0);
for (let i = 0; i < 5; i++) recordFailure(ip);
assert.ok(lockedFor(ip) > 0, 'five failures locks the address out');
clearFailures(ip);
assert.equal(lockedFor(ip), 0);

// Everything above persisted; a fresh init sees the same people, not a new bootstrap admin.
await initAuth(dir, '111111');
assert.equal(listUsers().length, 1);
assert.equal((await userByCode('555555')).id, owner.id);

await fs.rm(dir, { recursive: true, force: true });
console.log('ok');
