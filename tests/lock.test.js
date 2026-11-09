'use strict';
// Unit tests for tool/lock.js (passphrase lock) and how journal.js treats a locked journal.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../tool/lock.js');
const J = require('../tool/journal.js');
const { sampleJournal } = require('../tool/sample-journal.js');

const NOW = Date.parse('2026-11-09T18:00:00Z');
const FAST = { iterations: 1000 }; // real locks use L.ITERATIONS; tests stay quick
const journal = () => J.normalize(sampleJournal(NOW)).journal;

function memStorage(initial) {
  const m = new Map(Object.entries(initial || {}));
  return {
    get length() { return m.size; },
    key: i => Array.from(m.keys())[i] ?? null,
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
    dump: () => Object.fromEntries(m)
  };
}

test('a sealed journal opens with the right passphrase and holds no readable text', async () => {
  const j = journal();
  const keyInfo = await L.deriveKey('a long quiet morning', FAST);
  const env = await L.seal(j, keyInfo, { autoLock: 5, now: NOW });
  assert.equal(L.isLocked(env), true);
  assert.equal(L.checkEnvelope(env), null);
  assert.equal(env.version, 2);
  assert.equal(env.autoLockMinutes, 5);
  const stored = JSON.stringify(env);
  for (const word of ['quarterly', 'sister', 'Overwhelmed', 'sample-t-work', 'Work']) {
    assert.equal(stored.includes(word), false, '"' + word + '" must not appear in the stored lock');
  }
  assert.equal(stored.includes('a long quiet morning'), false, 'the passphrase is never stored');
  const r = await L.unlock(env, 'a long quiet morning');
  assert.equal(r.ok, true);
  assert.deepEqual(J.normalize(r.raw).journal, j);
});

test('each save uses a fresh IV, and each new lock a fresh salt', async () => {
  const a = await L.deriveKey('same words here', FAST);
  const b = await L.deriveKey('same words here', FAST);
  assert.notEqual(a.kdf.salt, b.kdf.salt);
  const e1 = await L.seal(journal(), a, {});
  const e2 = await L.seal(journal(), a, {});
  assert.notEqual(e1.cipher.iv, e2.cipher.iv);
  assert.notEqual(e1.data, e2.data);
  assert.equal(L.ITERATIONS >= 600000, true, 'real locks use a slow key derivation');
});

test('a wrong passphrase is refused clearly and never throws', async () => {
  const env = await L.seal(journal(), await L.deriveKey('correct horse battery', FAST), {});
  const wrong = await L.unlock(env, 'Correct horse battery');
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /did not open the journal/);
  assert.match((await L.unlock(env, '')).error, /Type your passphrase/);
});

test('damaged or newer locks are reported, not opened', async () => {
  const env = await L.seal(journal(), await L.deriveKey('passphrase one', FAST), {});
  assert.match(L.checkEnvelope(Object.assign({}, env, { version: 3 })), /newer version/);
  assert.match(L.checkEnvelope(Object.assign({}, env, { kdf: Object.assign({}, env.kdf, { salt: '' }) })), /lock settings are damaged/);
  assert.match(L.checkEnvelope(Object.assign({}, env, { kdf: Object.assign({}, env.kdf, { iterations: 5 }) })), /damaged/);
  assert.match(L.checkEnvelope(Object.assign({}, env, { data: 'not base64!' })), /locked data is damaged/);
  assert.match(L.checkEnvelope({ hello: 1 }), /not a locked/);
  // Flip one byte of the sealed data: AES-GCM refuses it rather than returning garbage.
  const bytes = Buffer.from(env.data, 'base64'); bytes[0] ^= 1;
  const tampered = Object.assign({}, env, { data: bytes.toString('base64') });
  assert.equal((await L.unlock(tampered, 'passphrase one')).ok, false);
  const damaged = await L.unlock(Object.assign({}, env, { cipher: { name: 'AES-GCM', iv: 'AA==' } }), 'passphrase one');
  assert.equal(damaged.damaged, true);
});

test('new passphrases need 8 characters, real text and a matching confirmation', () => {
  assert.match(L.checkNewPassphrase('short', 'short'), /at least 8/);
  assert.match(L.checkNewPassphrase('        ', '        '), /only spaces/);
  assert.match(L.checkNewPassphrase('long enough', 'long enougH'), /do not match/);
  assert.equal(L.checkNewPassphrase('long enough', 'long enough'), null);
});

test('reopen uses the key in memory, and notices a passphrase changed elsewhere', async () => {
  const k1 = await L.deriveKey('first passphrase', FAST);
  const env = await L.seal(journal(), k1, {});
  assert.equal((await L.reopen(env, k1)).ok, true);
  const k2 = await L.deriveKey('second passphrase', FAST);
  const env2 = await L.seal(journal(), k2, {});
  const r = await L.reopen(env2, k1);
  assert.equal(r.ok, false);
  assert.equal(r.rekeyed, true);
});

test('auto-lock choices fall back to the default for anything unknown', () => {
  assert.equal(L.autoLockMinutes({ autoLockMinutes: 0 }), 0);
  assert.equal(L.autoLockMinutes({ autoLockMinutes: 60 }), 60);
  assert.equal(L.autoLockMinutes({ autoLockMinutes: 7 }), L.DEFAULT_AUTO_LOCK);
  assert.equal(L.autoLockMinutes(null), L.DEFAULT_AUTO_LOCK);
});

test('journal load leaves a locked journal untouched and does not migrate drafts into the open', async () => {
  const env = await L.seal(journal(), await L.deriveKey('passphrase one', FAST), {});
  const raw = JSON.stringify(env);
  const s = memStorage({ [J.STORAGE_KEY]: raw, 'sb-feel': JSON.stringify(['old draft']) });
  const r = J.load(s, NOW);
  assert.deepEqual(r.locked, env);
  assert.equal(r.persistent, true);
  assert.equal(r.journal.entries.length, 0);
  assert.equal(s.getItem(J.STORAGE_KEY), raw, 'nothing saved over the lock');
  assert.deepEqual(J.corruptBackups(s), [], 'a lock is not mistaken for damaged data');
});

test('an older page (schema 1) treats a lock as newer data and will not overwrite it', async () => {
  const env = await L.seal(journal(), await L.deriveKey('passphrase one', FAST), {});
  assert.equal(J.normalize(env).tooNew, true);
});

test('importing a locked backup asks for its passphrase', async () => {
  const env = await L.seal(journal(), await L.deriveKey('passphrase one', FAST), {});
  const p = J.parseImport(JSON.stringify(env));
  assert.equal(p.ok, false);
  assert.deepEqual(p.locked, env);
  assert.match(p.error, /locked/);
});
