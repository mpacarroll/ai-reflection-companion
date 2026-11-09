/*
  Sounding Board journal lock.

  Optional passphrase lock for the journal on this device. Plain script, no dependencies,
  no network. Runs in the page (window.SBLock) and in Node for tests (module.exports).
  Uses the browser's built-in Web Crypto: PBKDF2-SHA-256 turns the passphrase into an
  AES-GCM key, and every save is sealed with a fresh random IV.

  Ground rules this file enforces:
  - The passphrase and the key never leave memory. Nothing that could unlock the journal
    is written to storage or to an export.
  - A forgotten passphrase cannot be recovered. The interface says so before the lock is
    turned on, and offers a backup first.
  - The stored lock is version 2, so an older copy of this page (which only knows
    version 1) treats it as "made by a newer version" and refuses to save over it.
*/
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SBLock = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KIND = 'sounding-board-locked';
  const VERSION = 2;
  const ITERATIONS = 600000;
  const MIN_LENGTH = 8;
  const AUTO_LOCK_CHOICES = [
    { minutes: 0, label: 'Only when I lock it or close the page' },
    { minutes: 5, label: 'After 5 minutes without use' },
    { minutes: 15, label: 'After 15 minutes without use' },
    { minutes: 60, label: 'After 1 hour without use' }
  ];
  const DEFAULT_AUTO_LOCK = 15;

  function cryptoApi() {
    const c = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
    return c && c.subtle && typeof c.getRandomValues === 'function' ? c : null;
  }
  /** True when this browser can lock the journal (Web Crypto needs https or a local file). */
  function available() { return !!cryptoApi(); }

  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }

  function toB64(bytes) {
    const u = new Uint8Array(bytes);
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function validB64(s, minBytes) {
    if (typeof s !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(s)) return false;
    try { return fromB64(s).length >= minBytes; } catch (err) { return false; }
  }

  /** Is this stored or imported object a locked journal? Checks shape, not the passphrase. */
  function isLocked(x) {
    return isObj(x) && x.kind === KIND && x.encrypted === true;
  }

  /** Is the locked journal well formed enough to try a passphrase on? */
  function checkEnvelope(x) {
    if (!isLocked(x)) return 'This is not a locked Sounding Board journal.';
    if (typeof x.version !== 'number' || x.version > VERSION) return 'This locked journal was made by a newer version of Sounding Board.';
    const k = x.kdf, c = x.cipher;
    if (!isObj(k) || k.name !== 'PBKDF2' || k.hash !== 'SHA-256' || !Number.isInteger(k.iterations) || k.iterations < 1000 || k.iterations > 10000000 || !validB64(k.salt, 16)) return 'The lock settings are damaged, so this journal cannot be opened.';
    if (!isObj(c) || c.name !== 'AES-GCM' || !validB64(c.iv, 12) || !validB64(x.data, 17)) return 'The locked data is damaged, so this journal cannot be opened.';
    return null;
  }

  /** Check a new passphrase and its confirmation. Returns an error message or null. */
  function checkNewPassphrase(pass, confirm) {
    const p = typeof pass === 'string' ? pass : '';
    if (p.length < MIN_LENGTH) return 'Use at least ' + MIN_LENGTH + ' characters. A short sentence you will remember works well.';
    if (!p.trim()) return 'A passphrase cannot be only spaces.';
    if (confirm !== undefined && p !== confirm) return 'The two passphrases do not match.';
    return null;
  }

  function autoLockMinutes(x) {
    const m = isObj(x) ? x.autoLockMinutes : undefined;
    return AUTO_LOCK_CHOICES.some(c => c.minutes === m) ? m : DEFAULT_AUTO_LOCK;
  }

  /**
   * Derive a key from a passphrase. Pass the salt and iteration count from a stored lock to
   * reopen it, or leave them out to start a new lock. Returns { key, kdf }; the key cannot
   * be exported.
   */
  async function deriveKey(passphrase, { salt, iterations } = {}) {
    const c = cryptoApi();
    if (!c) throw new Error('Locking is not available in this browser.');
    const saltBytes = salt ? fromB64(salt) : c.getRandomValues(new Uint8Array(16));
    const iters = iterations || ITERATIONS;
    const base = await c.subtle.importKey('raw', new TextEncoder().encode(String(passphrase)), 'PBKDF2', false, ['deriveKey']);
    const key = await c.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: iters },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    return { key, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: iters, salt: toB64(saltBytes) } };
  }

  /** Seal a journal object with a derived key. Returns the object to store. */
  async function seal(journal, keyInfo, { autoLock, now } = {}) {
    const c = cryptoApi();
    const iv = c.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify(journal));
    const data = await c.subtle.encrypt({ name: 'AES-GCM', iv }, keyInfo.key, plain);
    return {
      kind: KIND,
      version: VERSION,
      encrypted: true,
      kdf: Object.assign({}, keyInfo.kdf),
      cipher: { name: 'AES-GCM', iv: toB64(iv) },
      autoLockMinutes: AUTO_LOCK_CHOICES.some(x => x.minutes === autoLock) ? autoLock : DEFAULT_AUTO_LOCK,
      savedAt: new Date(now === undefined ? Date.now() : now).toISOString(),
      data: toB64(data)
    };
  }

  async function decrypt(envelope, key) {
    const c = cryptoApi();
    const plain = await c.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(envelope.cipher.iv) }, key, fromB64(envelope.data));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  /**
   * Open a locked journal with a passphrase. Returns { ok: true, raw, keyInfo } where raw is
   * the stored journal object (still to be normalized), or { ok: false, error }.
   */
  async function unlock(envelope, passphrase) {
    const bad = checkEnvelope(envelope);
    if (bad) return { ok: false, error: bad, damaged: true };
    if (!available()) return { ok: false, error: 'This browser cannot open locked journals.' };
    if (typeof passphrase !== 'string' || !passphrase) return { ok: false, error: 'Type your passphrase.' };
    let keyInfo;
    try { keyInfo = await deriveKey(passphrase, { salt: envelope.kdf.salt, iterations: envelope.kdf.iterations }); }
    catch (err) { return { ok: false, error: 'This browser could not open the lock.' }; }
    try { return { ok: true, raw: await decrypt(envelope, keyInfo.key), keyInfo }; }
    catch (err) { return { ok: false, error: 'That passphrase did not open the journal. Check for typos and capital letters.' }; }
  }

  /**
   * Open a newer save of the same lock with a key already in memory (another tab saved).
   * Returns { ok: false, rekeyed: true } when the passphrase was changed elsewhere.
   */
  async function reopen(envelope, keyInfo) {
    if (checkEnvelope(envelope)) return { ok: false, error: 'damaged' };
    if (!keyInfo || envelope.kdf.salt !== keyInfo.kdf.salt || envelope.kdf.iterations !== keyInfo.kdf.iterations) return { ok: false, rekeyed: true };
    try { return { ok: true, raw: await decrypt(envelope, keyInfo.key) }; }
    catch (err) { return { ok: false, rekeyed: true }; }
  }

  return {
    KIND, VERSION, ITERATIONS, MIN_LENGTH, AUTO_LOCK_CHOICES, DEFAULT_AUTO_LOCK,
    available, isLocked, checkEnvelope, checkNewPassphrase, autoLockMinutes,
    deriveKey, seal, unlock, reopen
  };
});
