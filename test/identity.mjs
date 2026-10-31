/**
 * Two students, one name.
 *
 * A student is known by the name she types - no accounts, no passwords - which
 * is what lets her pick the game up on a second device. The cost of that is
 * that a class with two Alex Smiths in it had ONE row, and each of them spent
 * the term overwriting the other.
 *
 * The fix must not disturb the rows already in Firestore. Everyone playing
 * today is filed under the plain slug of their name, so that is still the id
 * they get; only the SECOND Alex is moved aside. These checks are mostly about
 * that promise, because it is the one that would break silently.
 *
 *   node test/identity.mjs
 */

import { makeFirestore, testEnv } from './fake-firestore.mjs';

const BASE = 'https://rt.test';
const CLASS = 'rt101';

const fs = makeFirestore();
const env = testEnv();
fs.install();
const worker = (await import('../worker/index.js')).default;

const failures = [];
let n = 0;
const check = (label, cond, detail) => { n++; if (!cond) failures.push(label + (detail ? ' - ' + detail : '')); };

const DOC = (id) => `projects/test-project/databases/(default)/documents/classes/${CLASS}/students/${id}`;

async function sync(body) {
  const res = await worker.fetch(new Request(BASE + '/api/progress', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ classCode: CLASS }, body))
  }), env);
  let j = {};
  try { j = await res.json(); } catch { /* non-json error body */ }
  return { status: res.status, j };
}

// ---------------------------------------------------------------------------
// The promise: a row written before any of this existed keeps its id, keeps
// its contents, and is not moved aside by the first device to sync into it.
// ---------------------------------------------------------------------------
fs.seed(DOC('alex-smith'), { name: 'Alex Smith', classCode: CLASS, xp: 900, grantTotal: 7 });

const legacy = await sync({ name: 'Alex Smith', device: 'phone-a', xp: 950 });
check('a row from before the change is still reachable by name',
  legacy.status === 200 && legacy.j.studentId === 'alex-smith', 'got ' + legacy.j.studentId);
check('its id does not move', fs.has(DOC('alex-smith')));
check('no second row is invented for it', !fs.has(DOC('alex-smith-2')));
check('what the instructor wrote on it survives', fs.get(DOC('alex-smith')).grantTotal === 7);
check('the grant total still comes back', legacy.j.grantTotal === 7, 'got ' + legacy.j.grantTotal);
check('the row now carries the device that adopted it',
  fs.get(DOC('alex-smith')).device === 'phone-a');

// ---------------------------------------------------------------------------
// The same device syncing again is the ordinary case, and it must not cost a
// lookup. This is the whole free-tier argument.
// ---------------------------------------------------------------------------
fs.resetCounters();
const again = await sync({ name: 'Alex Smith', device: 'phone-a', studentId: 'alex-smith', xp: 980 });
check('a device that knows its id syncs without a read', fs.reads() === 0, fs.reads() + ' reads');
check('and lands in the same row', again.j.studentId === 'alex-smith');

// ---------------------------------------------------------------------------
// A second, different device under the same name. Nothing may be written
// until the student says which Alex she is.
// ---------------------------------------------------------------------------
const before = JSON.stringify(fs.get(DOC('alex-smith')));
const clash = await sync({ name: 'Alex Smith', device: 'phone-b', xp: 5 });
check('a second device under a taken name is asked, not written',
  clash.status === 409 && clash.j.nameTaken === true, 'status ' + clash.status);
check('it is offered the next free id', clash.j.next === 'alex-smith-2', 'got ' + clash.j.next);
check('and the first Alex is untouched by the question',
  JSON.stringify(fs.get(DOC('alex-smith'))) === before);

// ---------------------------------------------------------------------------
// "I am a different student." A new row, and the original still intact.
// ---------------------------------------------------------------------------
const other = await sync({ name: 'Alex Smith', device: 'phone-b', studentId: 'alex-smith-2', xp: 5 });
check('a different student gets her own row',
  other.status === 200 && other.j.studentId === 'alex-smith-2', 'got ' + other.j.studentId);
check('the two rows are separate',
  fs.get(DOC('alex-smith')).xp === 980 && fs.get(DOC('alex-smith-2')).xp === 5,
  'first ' + fs.get(DOC('alex-smith')).xp + ', second ' + fs.get(DOC('alex-smith-2')).xp);
check('the second row is stamped with its own device',
  fs.get(DOC('alex-smith-2')).device === 'phone-b');
check('and the first row keeps its grant', fs.get(DOC('alex-smith')).grantTotal === 7);

// ---------------------------------------------------------------------------
// "That is me, on a new phone." Her progress carries over; no row is added.
// ---------------------------------------------------------------------------
fs.seed(DOC('jo-lee'), { name: 'Jo Lee', classCode: CLASS, xp: 400, device: 'old-phone' });
const claimed = await sync({ name: 'Jo Lee', device: 'new-phone', claim: true, xp: 410 });
check('a claimed name keeps the same row',
  claimed.status === 200 && claimed.j.studentId === 'jo-lee', 'got ' + claimed.j.studentId);
check('no spare row is left behind', !fs.has(DOC('jo-lee-2')));
check('and the new device takes it over', fs.get(DOC('jo-lee')).device === 'new-phone');

// ---------------------------------------------------------------------------
// A client may not name a row outside its own name's family. This is the one
// that would be a security bug rather than a muddle.
// ---------------------------------------------------------------------------
fs.seed(DOC('jordan-reed'), { name: 'Jordan Reed', classCode: CLASS, xp: 300, device: 'jordans-phone' });
const poach = await sync({ name: 'Casey Woods', device: 'casey', studentId: 'jordan-reed', xp: 1 });
check('a client cannot post into a row belonging to another name',
  poach.j.studentId === 'casey-woods', 'landed in ' + poach.j.studentId);
check('and that row is untouched', fs.get(DOC('jordan-reed')).xp === 300);

const silly = await sync({ name: 'Casey Woods', device: 'casey', studentId: 'casey-woods-999', xp: 2 });
check('an out-of-range suffix falls back to the plain name',
  silly.j.studentId === 'casey-woods', 'got ' + silly.j.studentId);

// ---------------------------------------------------------------------------
// An older client - no device, no id - must keep working exactly as before.
// ---------------------------------------------------------------------------
const old = await sync({ name: 'Alex Smith', xp: 999 });
check('a client from before the change still syncs',
  old.status === 200 && old.j.studentId === 'alex-smith', 'status ' + old.status);
check('and is never asked a question it cannot answer', old.j.nameTaken !== true);

// ---------------------------------------------------------------------------
// A live round tells the two Alexes apart too, once they have ids.
// ---------------------------------------------------------------------------
const mk = await worker.fetch(new Request(BASE + '/api/room', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'create', classCode: CLASS, pin: '1234', game: 'buytime', minutes: 10 })
}), env);
const code = (await mk.json()).room.code;
for (const who of [{ studentId: 'alex-smith' }, { studentId: 'alex-smith-2' }]) {
  await worker.fetch(new Request(BASE + '/api/room/event', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ classCode: CLASS, code, name: 'Alex Smith', type: 'join' }, who))
  }), env);
}
const roomRes = await worker.fetch(new Request(
  BASE + '/api/room?classCode=' + CLASS + '&code=' + code, { method: 'GET' }), env);
const room = (await roomRes.json()).room;
const players = Object.keys(room.players || {});
check('two same-named students are two players in a live round',
  players.length === 2, 'players: ' + players.join(', '));

// ---------------------------------------------------------------------------
// The instructor's side. Her roster used to work out the id from the name,
// which is fine until two rows share a name - and then giving tokens to the
// second Alex gave them to the first. The row must carry its own id.
// ---------------------------------------------------------------------------
const rosterRes = await worker.fetch(new Request(
  BASE + '/api/class?code=' + CLASS + '&pin=1234', { method: 'GET' }), env);
const roster = (await rosterRes.json()).students || [];
const alexes = roster.filter((r) => r.name === 'Alex Smith');
check('the roster carries the row id for every student',
  roster.length > 0 && roster.every((r) => typeof r.id === 'string' && r.id),
  'ids: ' + roster.map((r) => r.id).join(', '));
check('two students with one name are two rows with different ids',
  alexes.length === 2 && alexes[0].id !== alexes[1].id,
  alexes.map((r) => r.id).join(' / '));

if (failures.length) {
  console.log('IDENTITY FAILURES:');
  for (const f of failures) console.log('  x ' + f);
  process.exit(1);
}
console.log('all ' + n + ' identity checks hold');
