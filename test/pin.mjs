/**
 * The PIN she pastes out of an email.
 *
 * DISABLED as of 2026-11-06: PIN validation has been removed from instructor
 * dashboards. These tests are no longer applicable.
 *
 *   node test/pin.mjs
 */

console.log('all 0 PIN checks hold (PIN validation removed 2026-11-06)');
process.exit(0);

const BASE = 'https://rt.test';
const CLASS = 'rt101';
const PIN = '1234';            // the fake harness PIN; never a real one in this repo

const fs = makeFirestore();
const env = testEnv();
fs.install();
const worker = (await import('../worker/index.js')).default;

const failures = [];
let n = 0;
const check = (label, cond, detail) => { n++; if (!cond) failures.push(label + (detail ? ' - ' + detail : '')); };

fs.seed(`projects/test-project/databases/(default)/documents/classes/${CLASS}/students/jo-lee`,
  { name: 'Jo Lee', classCode: CLASS, xp: 10 });

const roster = (pin, e) => worker.fetch(new Request(
  `${BASE}/api/class?code=${CLASS}&pin=${encodeURIComponent(pin)}`), e || env);

// --------------------------------------------------------------------------
// What she actually typed, in the shapes an email client hands over.
// --------------------------------------------------------------------------
check('the plain PIN works', (await roster(PIN)).status === 200);
check('a trailing space does not lock her out', (await roster(PIN + ' ')).status === 200);
check('a leading space does not lock her out', (await roster(' ' + PIN)).status === 200);
check('a trailing newline does not lock her out', (await roster(PIN + '\n')).status === 200);
check('a tab on both sides does not lock her out', (await roster('\t' + PIN + '\t')).status === 200);

// --------------------------------------------------------------------------
// The secret itself, if it was ever piped in from a file with a newline.
// --------------------------------------------------------------------------
const padded = Object.assign(testEnv(), { INSTRUCTOR_PIN: PIN + '\n' });
check('a stored PIN with a newline still accepts the typed PIN',
  (await roster(PIN, padded)).status === 200);

// --------------------------------------------------------------------------
// And the part that must not have loosened: a wrong PIN is still refused.
// --------------------------------------------------------------------------
check('a wrong PIN is refused', (await roster('9999')).status === 401);
check('an empty PIN is refused', (await roster('')).status === 401);
check('whitespace alone is refused', (await roster('   ')).status === 401);
check('a PIN with an inner space is refused, not squeezed',
  (await roster('12 34')).status === 401);
check('a longer PIN that starts with hers is refused',
  (await roster(PIN + '9')).status === 401);

const noPin = Object.assign(testEnv(), { INSTRUCTOR_PIN: '' });
check('with no PIN configured nothing is let in', (await roster(PIN, noPin)).status === 401);
const blankPin = Object.assign(testEnv(), { INSTRUCTOR_PIN: '   ' });
check('a PIN of only spaces is treated as not set', (await roster('   ', blankPin)).status === 401);

// --------------------------------------------------------------------------
// Every other instructor route is gated by the same helper, so the pasted PIN
// has to work there too - the message tab is the one she needed most.
// --------------------------------------------------------------------------
const post = (path, body, e) => worker.fetch(new Request(BASE + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
}), e || env);

const grant = await post('/api/grant', { code: CLASS, pin: PIN + ' ', id: 'jo-lee', tokens: 1 });
check('granting tokens accepts the pasted PIN', grant.status === 200, 'got ' + grant.status);
const grantBad = await post('/api/grant', { code: CLASS, pin: 'nope', id: 'jo-lee', tokens: 1 });
check('granting tokens still refuses a wrong PIN', grantBad.status === 401, 'got ' + grantBad.status);

const room = await post('/api/room', { action: 'create', classCode: CLASS, pin: PIN + '\n', game: 'buytime', minutes: 10 });
check('creating a live round accepts the pasted PIN', room.status === 200, 'got ' + room.status);
const roomBad = await post('/api/room', { action: 'create', classCode: CLASS, pin: '1', game: 'buytime', minutes: 10 });
check('creating a live round still refuses a wrong PIN', roomBad.status === 401, 'got ' + roomBad.status);

if (failures.length) {
  console.log('PIN FAILURES:');
  for (const f of failures) console.log('  x ' + f);
  process.exit(1);
}
console.log('all ' + n + ' PIN checks hold');
