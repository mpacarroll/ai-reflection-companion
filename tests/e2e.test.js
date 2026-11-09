'use strict';
// Browser tests for tool/index.html, using the preinstalled Playwright and the page's own files
// (file:// URL, no server). Run: npm run test:e2e
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium, devices } = require('playwright');

const PAGE = 'file://' + path.resolve(__dirname, '..', 'tool', 'index.html');
const SHOTS = process.env.SB_SHOTS || '';

let browser;
test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { await browser.close(); });

async function open(opts = {}) {
  const context = await browser.newContext(Object.assign({ acceptDownloads: true }, opts.context || {}));
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('request', r => { if (!r.url().startsWith('file://') && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) requests.push(r.url()); });
  if (opts.init) await page.addInitScript(opts.init);
  await page.goto(PAGE);
  return { context, page, errors, requests };
}
const journal = page => page.evaluate(() => window.SoundingBoard.journal);
async function toJournal(page, view) {
  await page.click('.tab[data-t="journal"]');
  if (view) await page.click('[data-view="' + view + '"]');
}
async function loadSample(page) {
  await toJournal(page, 'data');
  await page.click('#sample-load');
}
async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true });
}

test('save from Untangle creates a journal entry that persists across reloads', async () => {
  const { context, page, errors, requests } = await open();
  await page.fill('#f-happened', 'The bus was late and I missed the start of class.');
  await page.fill('#f-thought', 'I am always late.');
  await page.fill('#f-step', 'Leave ten minutes earlier tomorrow.');
  await page.click('#untangle [data-save]');
  assert.match(await page.textContent('#untangle-msg'), /Saved to your journal, on this device only/);
  assert.equal(await page.inputValue('#f-happened'), '', 'form clears so the next save is a new entry');
  assert.equal(await page.textContent('#jcount'), '1');
  await page.reload();
  const j = await journal(page);
  assert.equal(j.entries.length, 1);
  assert.equal(j.entries[0].mode, 'untangle');
  assert.equal(j.entries[0].step.status, 'open');
  await page.fill('#f-happened', 'Second one');
  await page.click('#untangle [data-save]');
  await page.click('#untangle-msg >> text=Open it');
  assert.equal(await page.isVisible('#journal'), true);
  assert.match(await page.textContent('#j-list'), /The bus was late/);
  assert.equal(await page.getAttribute('.entry.open .entry-head', 'aria-expanded'), 'true');
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, [], 'no network requests');
  await context.close();
});

test('Name the feeling saves the chosen feelings, and an empty save is refused', async () => {
  const { context, page } = await open();
  await page.click('.tab[data-t="feel"]');
  await page.click('#feel [data-save]');
  assert.match(await page.textContent('#feel-msg'), /Nothing to save yet/);
  await page.click('#feelchips >> text=Tired');
  await page.click('#feelchips >> text=Hopeful');
  await page.click('#feel [data-save]');
  const j = await journal(page);
  assert.deepEqual(j.entries[0].feelings, ['Tired', 'Hopeful']);
  assert.equal(await page.locator('#feelchips .chip[aria-pressed="true"]').count(), 0);
  await context.close();
});

test('themes: create with keywords, see a suggestion with its reason, tag, filter, delete', async () => {
  const { context, page } = await open();
  await page.click('.tab[data-t="good"]');
  await page.fill('#f-okay', 'Slept a full night for once.');
  await page.click('#good [data-save]');
  await toJournal(page, 'themes');
  await page.fill('#th-name', 'Sleep');
  await page.fill('#th-kw', 'sleep, slept, night');
  await page.click('#th-add');
  await page.fill('#th-name', 'sleep');
  await page.click('#th-add');
  assert.match(await page.textContent('#th-msg'), /already have a theme/);
  await page.click('[data-view="entries"]');
  await page.click('.entry-head');
  const suggest = await page.textContent('.suggest');
  assert.match(suggest, /Maybe Sleep\? You gave that theme the words "slept", "night"/);
  await page.click('[data-suggest]');
  let j = await journal(page);
  assert.equal(j.entries[0].themeIds.length, 1);
  assert.equal(await page.locator('.suggest').count(), 0);
  await page.selectOption('#j-theme', { label: 'No theme yet' });
  assert.match(await page.textContent('#j-count'), /Showing 0 of 1/);
  await page.click('[data-view="themes"]');
  await page.click('[data-theme-delete]');
  await page.click('[data-theme-delete-yes]');
  j = await journal(page);
  assert.equal(j.themes.length, 0);
  assert.equal(j.entries.length, 1, 'deleting a theme keeps entries');
  assert.deepEqual(j.entries[0].themeIds, []);
  await context.close();
});

test('look-back summary links every item to the entry it came from', async () => {
  const { context, page, errors } = await open();
  await loadSample(page);
  await page.click('[data-view="lookback"]');
  assert.equal(await page.inputValue('#lb-range'), '30');
  const head = await page.textContent('#lb-out h3');
  assert.match(head, /In the last 30 days, you wrote 9 entries on 9 days\./);
  assert.match(await page.textContent('#lb-limits'), /does not interpret your entries/);
  const items = page.locator('#lb-out li');
  const n = await items.count();
  assert.ok(n >= 10);
  for (let i = 0; i < n; i++) assert.ok(await items.nth(i).locator('[data-source]').count() >= 1, 'item ' + i + ' has a source link');
  await shot(page, 'lookback-desktop');
  // Following a source opens the exact entry.
  const first = page.locator('#lb-out li[data-section="steps"] [data-source]').first();
  const id = await first.getAttribute('data-source');
  await first.click();
  const card = page.locator('#entry-' + id);
  assert.equal(await card.getAttribute('class'), 'entry open');
  assert.match(await card.textContent(), /Ask my manager which two sections matter most/);
  // Theme filter narrows the look-back.
  await page.click('[data-view="lookback"]');
  await page.selectOption('#lb-theme', { label: 'Sleep' });
  assert.match(await page.textContent('#lb-out h3'), /tagged Sleep, you wrote 3 entries/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('review: prompts say why, marking a step updates it, and answers save as a linked review', async () => {
  const { context, page } = await open();
  await loadSample(page);
  await page.click('[data-view="review"]');
  const prompts = page.locator('.prompt');
  assert.ok(await prompts.count() >= 3);
  for (let i = 0; i < await prompts.count(); i++) assert.match(await prompts.nth(i).locator('.why').textContent(), /^Why this question: .{10,}/);
  await page.click('#rv-save');
  assert.match(await page.textContent('#rv-msg'), /Answer at least one question/);
  const stepPrompt = page.locator('.prompt[data-kind="step"]');
  assert.match(await stepPrompt.locator('label').textContent(), /Call mom back on Saturday morning/);
  await stepPrompt.locator('[data-step="done"]').click();
  let j = await journal(page);
  assert.equal(j.entries.find(e => e.id === 'sample-8').step.status, 'done');
  assert.equal(await page.locator('.prompt[data-kind="step"]').count(), 0, 'a marked step drops out');
  await page.fill('.prompt[data-kind="feeling"] textarea', 'Both times were the night before a work deadline.');
  await page.click('#rv-save');
  j = await journal(page);
  const review = j.entries.find(e => e.mode === 'review');
  assert.ok(review);
  assert.deepEqual(review.sources.sort(), ['sample-6', 'sample-9']);
  assert.match(review.fields.text, /night before a work deadline/);
  await page.click('#rv-msg >> text=Open it');
  assert.match(await page.textContent('#entry-' + review.id), /Looks back at: Nov 3/);
  await context.close();
});

test('edit, delete with undo, and the step status buttons on an entry', async () => {
  const { context, page } = await open();
  await loadSample(page);
  await page.click('[data-view="entries"]');
  await page.click('#entry-sample-4 .entry-head');
  await page.click('[data-edit="sample-4"]');
  await page.fill('#edit-sample-4-text', 'Could not sleep. Wrote it down and that helped.');
  await page.click('[data-save-edit="sample-4"]');
  let j = await journal(page);
  const e4 = j.entries.find(e => e.id === 'sample-4');
  assert.equal(e4.fields.text, 'Could not sleep. Wrote it down and that helped.');
  assert.notEqual(e4.updatedAt, e4.createdAt);
  assert.match(await page.textContent('#entry-sample-4'), /Edited /);
  // Clearing every field is refused.
  await page.click('[data-edit="sample-4"]');
  await page.fill('#edit-sample-4-text', '   ');
  await page.click('[data-save-edit="sample-4"]');
  assert.match(await page.textContent('#entry-sample-4'), /To remove it, use Delete/);
  await page.click('#entry-sample-4 >> text=Cancel');
  await page.click('[data-delete="sample-4"]');
  j = await journal(page);
  assert.equal(j.entries.length, 8);
  await page.click('#j-undo');
  j = await journal(page);
  assert.equal(j.entries.length, 9);
  await page.reload();
  assert.equal((await journal(page)).entries.length, 9, 'undo is saved');
  await toJournal(page);
  await page.click('#entry-sample-5 .entry-head');
  await page.click('#entry-sample-5 [data-step="let-go"]');
  j = await journal(page);
  assert.equal(j.entries.find(e => e.id === 'sample-5').step.status, 'let-go');
  await context.close();
});

test('search and kind filters', async () => {
  const { context, page } = await open();
  await loadSample(page);
  await page.click('[data-view="entries"]');
  await page.fill('#j-search', 'sister');
  assert.match(await page.textContent('#j-count'), /Showing 1 of 9/);
  await page.fill('#j-search', '');
  await page.selectOption('#j-mode', 'feel');
  assert.match(await page.textContent('#j-count'), /Showing 3 of 9/);
  await context.close();
});

test('export JSON and text, then import into a fresh browser without loss or duplicates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-'));
  const a = await open();
  await loadSample(a.page);
  await a.page.click('[data-view="themes"]');
  await a.page.fill('#th-name', 'Health');
  await a.page.click('#th-add');
  await a.page.click('[data-view="data"]');
  const [dl] = await Promise.all([a.page.waitForEvent('download'), a.page.click('#ex-json')]);
  const jsonPath = path.join(dir, dl.suggestedFilename());
  await dl.saveAs(jsonPath);
  assert.match(dl.suggestedFilename(), /^sounding-board-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const [dl2] = await Promise.all([a.page.waitForEvent('download'), a.page.click('#ex-md')]);
  const mdPath = path.join(dir, 'journal.md');
  await dl2.saveAs(mdPath);
  const md = fs.readFileSync(mdPath, 'utf8');
  assert.match(md, /^# Sounding Board journal/);
  assert.match(md, /The quarterly report deadline moved up a week/);
  const original = await journal(a.page);
  await a.context.close();

  const b = await open();
  await toJournal(b.page, 'data');
  await b.page.setInputFiles('#im-file', jsonPath);
  await b.page.waitForFunction(() => /Imported/.test(document.querySelector('#im-msg')?.textContent || ''));
  assert.match(await b.page.textContent('#im-msg'), /Imported 9 entries, added 4 themes\./);
  assert.deepEqual(await journal(b.page), original);
  await b.page.setInputFiles('#im-file', jsonPath);
  await b.page.waitForFunction(() => /skipped 9/.test(document.querySelector('#im-msg')?.textContent || ''));
  assert.equal((await journal(b.page)).entries.length, 9);
  // A broken file is refused with a clear message.
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{"not": "a journal"');
  await b.page.setInputFiles('#im-file', bad);
  await b.page.waitForFunction(() => /not valid JSON/.test(document.querySelector('#im-msg')?.textContent || ''));
  await b.context.close();
});

test('remove sample entries keeps the person’s own writing', async () => {
  const { context, page } = await open();
  await page.fill('#f-happened', 'My own entry');
  await page.click('#untangle [data-save]');
  await loadSample(page);
  assert.equal((await journal(page)).entries.length, 10);
  await page.click('#sample-remove');
  const j = await journal(page);
  assert.deepEqual(j.entries.map(e => e.fields.happened), ['My own entry']);
  await context.close();
});

test('delete everything needs a second confirmation and clears storage', async () => {
  const { context, page } = await open();
  await loadSample(page);
  await page.click('#wipe');
  assert.match(await page.textContent('#j-view'), /cannot be undone/);
  await page.click('text=Keep my journal');
  assert.equal((await journal(page)).entries.length, 9);
  await page.click('#wipe');
  await page.click('#wipe-yes');
  assert.equal((await journal(page)).entries.length, 0);
  const keys = await page.evaluate(() => Object.keys(localStorage));
  assert.deepEqual(keys, []);
  await page.reload();
  assert.equal((await journal(page)).entries.length, 0);
  await context.close();
});

test('corrupt saved data is kept aside and offered for download, not destroyed', async () => {
  const { context, page } = await open({ init: () => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('sb-journal-v1', '{"version":1,"entries":[{"id":'); sessionStorage.setItem('seeded', '1'); } } });
  assert.match(await page.textContent('#j-notices'), /kept aside on this device/);
  assert.equal(await page.isVisible('#journal'), true, 'opens on the journal to show the notice');
  await page.click('[data-view="data"]');
  assert.match(await page.textContent('#j-view'), /Unreadable saved data/);
  const backup = await page.evaluate(() => Object.keys(localStorage).find(k => k.startsWith('sb-journal-corrupt-')));
  assert.equal(await page.evaluate(k => localStorage.getItem(k), backup), '{"version":1,"entries":[{"id":');
  await context.close();
});

test('drafts saved by the earlier version of the page become journal entries', async () => {
  const { context, page } = await open({ init: () => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('sb-good', JSON.stringify(['Finished the report', '', 'Asked for help'])); sessionStorage.setItem('seeded', '1'); } } });
  assert.match(await page.textContent('#j-notices'), /Brought 1 earlier saved draft into your journal/);
  const j = await journal(page);
  assert.equal(j.entries[0].fields.okay, 'Finished the report');
  assert.equal(await page.evaluate(() => localStorage.getItem('sb-good')), null);
  await context.close();
});

test('two open tabs never overwrite each other', async () => {
  const { context, page: a } = await open();
  const b = await context.newPage();
  await b.goto(PAGE);
  await a.fill('#f-happened', 'Written in the first tab');
  await a.click('#untangle [data-save]');
  await b.waitForFunction(() => window.SoundingBoard.journal.entries.length === 1);
  assert.equal(await b.textContent('#jcount'), '1');
  await b.fill('#f-happened', 'Written in the second tab');
  await b.click('#untangle [data-save]');
  await a.waitForFunction(() => window.SoundingBoard.journal.entries.length === 2);
  const c = await context.newPage();
  await c.goto(PAGE);
  const texts = (await journal(c)).entries.map(e => e.fields.happened).sort();
  assert.deepEqual(texts, ['Written in the first tab', 'Written in the second tab']);
  await context.close();
});

test('an edit in progress survives a save from another tab', async () => {
  const { context, page: a } = await open();
  await a.fill('#f-happened', 'Original text');
  await a.click('#untangle [data-save]');
  const id = (await journal(a)).entries[0].id;
  await toJournal(a);
  await a.click('#entry-' + id + ' .entry-head');
  await a.click('[data-edit="' + id + '"]');
  await a.fill('#edit-' + id + '-happened', 'Half-typed edit');
  const b = await context.newPage();
  await b.goto(PAGE);
  await b.fill('#f-happened', 'From the other tab');
  await b.click('#untangle [data-save]');
  await a.waitForFunction(() => window.SoundingBoard.journal.entries.length === 2);
  assert.equal(await a.inputValue('#edit-' + id + '-happened'), 'Half-typed edit');
  await a.click('[data-save-edit="' + id + '"]');
  const c = await context.newPage();
  await c.goto(PAGE);
  const texts = (await journal(c)).entries.map(e => e.fields.happened).sort();
  assert.deepEqual(texts, ['From the other tab', 'Half-typed edit']);
  await context.close();
});

test('blocked storage falls back to this tab only and says so', async () => {
  const { context, page, errors } = await open({ init: () => {
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
  } });
  assert.match(await page.textContent('#j-notices'), /only while this tab is open/);
  await page.click('.tab[data-t="untangle"]');
  await page.fill('#f-happened', 'Still works');
  await page.click('#untangle [data-save]');
  assert.match(await page.textContent('#untangle-msg'), /for this visit only/);
  assert.equal((await journal(page)).entries.length, 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('writing that suggests self-harm shows the crisis pointer; ordinary venting does not', async () => {
  const { context, page } = await open();
  await page.fill('#f-thought', 'This deadline is killing me');
  assert.equal(await page.locator('#untangle .safety').count(), 0);
  await page.fill('#f-thought', 'Some nights I want to die');
  assert.equal(await page.isVisible('#untangle .safety'), true);
  assert.match(await page.textContent('#untangle .safety'), /988/);
  await page.fill('#f-thought', 'Better now');
  assert.equal(await page.isVisible('#untangle .safety'), false);
  await context.close();
});

test('the crisis banner is always visible, on every tab and journal view', async () => {
  const { context, page } = await open();
  for (const t of ['untangle', 'feel', 'ground', 'good', 'journal']) {
    await page.click('.tab[data-t="' + t + '"]');
    assert.equal(await page.isVisible('.crisis'), true, t);
  }
  for (const v of ['entries', 'lookback', 'review', 'themes', 'data']) {
    await page.click('[data-view="' + v + '"]');
    assert.equal(await page.isVisible('.crisis'), true, v);
  }
  assert.match(await page.textContent('.crisis'), /988/);
  await context.close();
});

test('phone layout: no horizontal scroll and every control is labeled', async () => {
  const { context, page, errors } = await open({ context: devices['iPhone 13'] });
  await loadSample(page);
  for (const v of ['entries', 'lookback', 'review', 'themes', 'data']) {
    await page.click('[data-view="' + v + '"]');
    if (v === 'entries') await page.click('#entry-sample-1 .entry-head');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, v + ' overflows by ' + overflow + 'px');
    const unlabeled = await page.evaluate(() => Array.from(document.querySelectorAll('input, textarea, select')).filter(el => {
      if (el.type === 'hidden' || !el.offsetParent) return false;
      const id = el.id;
      return !(el.getAttribute('aria-label') || (id && document.querySelector('label[for="' + id + '"]')) || el.closest('label'));
    }).map(el => el.outerHTML.slice(0, 80)));
    assert.deepEqual(unlabeled, [], v + ' has unlabeled fields');
    const nameless = await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent && !b.textContent.trim() && !b.getAttribute('aria-label')).length);
    assert.equal(nameless, 0, v + ' has buttons without names');
    await shot(page, 'phone-' + v);
  }
  assert.deepEqual(errors, []);
  await context.close();
});

test('keyboard: an entry can be opened and a theme toggled without a mouse', async () => {
  const { context, page } = await open();
  await loadSample(page);
  await page.click('[data-view="entries"]');
  await page.focus('#entry-sample-6 .entry-head');
  await page.keyboard.press('Enter');
  assert.equal(await page.getAttribute('#entry-sample-6 .entry-head', 'aria-expanded'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement.closest('[data-entry]')?.dataset.entry), 'sample-6', 'focus stays on the entry after it opens');
  await page.focus('#entry-sample-6 [data-suggest]');
  await page.keyboard.press('Enter');
  await page.focus('#entry-sample-6 [data-theme-toggle="sample-t-work"]');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-theme-toggle')), 'sample-t-work', 'focus stays on the toggled theme');
  await page.keyboard.press('Enter');
  const j = await journal(page);
  assert.deepEqual(j.entries.find(e => e.id === 'sample-6').themeIds, ['sample-t-sleep']);
  await context.close();
});
