'use strict';
// Unit tests for the journal core. Run: npm test (sets TZ=UTC so day boundaries are stable).
const test = require('node:test');
const assert = require('node:assert/strict');
const J = require('../tool/journal.js');
const { sampleJournal } = require('../tool/sample-journal.js');

const NOW = Date.parse('2026-11-09T18:00:00Z');
const DAY = J.DAY;

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

function seeded() {
  return J.normalize(sampleJournal(NOW)).journal;
}

test('sample journal is valid, fully synthetic and marked as sample', () => {
  const n = J.normalize(sampleJournal(NOW));
  assert.equal(n.dropped, 0);
  assert.equal(n.journal.entries.length, 9);
  assert.ok(n.journal.entries.every(e => e.sample === true));
  assert.ok(n.journal.themes.every(t => t.sample === true));
});

test('addEntry keeps only known fields, trims empties and refuses an empty entry', () => {
  let j = J.emptyJournal();
  const empty = J.addEntry(j, { mode: 'untangle', fields: { happened: '   ', step: '' }, now: NOW });
  assert.ok(empty.error);
  const r = J.addEntry(j, { mode: 'untangle', fields: { happened: 'A thing', step: 'Rest tonight', bogus: 'x' }, now: NOW });
  assert.deepEqual(Object.keys(r.entry.fields).sort(), ['happened', 'step']);
  assert.equal(r.entry.step.status, 'open');
  assert.equal(r.journal.entries.length, 1);
  assert.equal(j.entries.length, 0, 'original journal is not mutated');
});

test('feelings-only entry is saved, unknown theme ids are dropped', () => {
  const r = J.addEntry(J.emptyJournal(), { mode: 'feel', fields: {}, feelings: ['Tired', 'Tired', ' Calm '], themeIds: ['nope'], now: NOW });
  assert.deepEqual(r.entry.feelings, ['Tired', 'Calm']);
  assert.deepEqual(r.entry.themeIds, []);
});

test('updateEntry edits text, refuses clearing everything, and manages the step', () => {
  let j = J.addEntry(J.emptyJournal(), { mode: 'untangle', fields: { happened: 'x' }, now: NOW, id: 'a' }).journal;
  assert.equal(J.getEntry(j, 'a').step, undefined);
  j = J.updateEntry(j, 'a', { fields: { happened: 'x', step: 'Call back' } }, NOW + 1000).journal;
  assert.equal(J.getEntry(j, 'a').step.status, 'open');
  assert.notEqual(J.getEntry(j, 'a').updatedAt, J.getEntry(j, 'a').createdAt);
  assert.ok(J.updateEntry(j, 'a', { fields: {} }, NOW).error);
  j = J.updateEntry(j, 'a', { fields: { happened: 'x' } }, NOW).journal;
  assert.equal(J.getEntry(j, 'a').step, undefined);
});

test('deleteEntry removes the entry and the review links to it; restoreEntry undoes it', () => {
  let j = seeded();
  j = J.addReview(j, { answers: [{ prompt: 'Q1', answer: 'It went fine', sources: ['sample-5', 'sample-9'] }], now: NOW, id: 'rev' }).journal;
  assert.deepEqual(J.getEntry(j, 'rev').sources, ['sample-5', 'sample-9']);
  const d = J.deleteEntry(j, 'sample-5');
  assert.equal(J.getEntry(d.journal, 'sample-5'), null);
  assert.deepEqual(J.getEntry(d.journal, 'rev').sources, ['sample-9']);
  const back = J.restoreEntry(d.journal, d.removed);
  assert.ok(J.getEntry(back.journal, 'sample-5'));
  assert.equal(back.journal.entries.length, j.entries.length);
});

test('themes: add, refuse duplicates, rename, delete keeps entries', () => {
  let j = seeded();
  assert.ok(J.addTheme(j, { name: 'work', now: NOW }).error, 'duplicate names are case-insensitive');
  assert.ok(J.addTheme(j, { name: '  ', now: NOW }).error);
  const added = J.addTheme(j, { name: 'Health', keywords: 'walk, Doctor ,walk', now: NOW, id: 't-h' });
  assert.deepEqual(added.theme.keywords, ['walk', 'doctor']);
  j = J.updateTheme(added.journal, 'sample-t-work', { name: 'Job' }).journal;
  assert.equal(j.themes.find(t => t.id === 'sample-t-work').name, 'Job');
  const before = j.entries.length;
  const del = J.deleteTheme(j, 'sample-t-work');
  assert.equal(del.journal.entries.length, before);
  assert.equal(del.untagged, 5);
  assert.ok(del.journal.entries.every(e => !e.themeIds.includes('sample-t-work')));
});

test('suggestThemes matches whole keywords only and says which words matched', () => {
  const j = seeded();
  const six = J.getEntry(j, 'sample-6');
  const s = J.suggestThemes(j, six);
  assert.deepEqual(s.map(x => x.name), ['Sleep']);
  assert.deepEqual(s[0].matched, ['sleep', 'tired', 'night']);
  // "bedrock" must not match "bed"; already-tagged themes are not suggested.
  const r = J.addEntry(j, { mode: 'free', fields: { text: 'Bedrock and teamwork' }, now: NOW, id: 'x' });
  assert.deepEqual(J.suggestThemes(r.journal, r.entry), []);
  const five = J.getEntry(j, 'sample-5');
  assert.ok(!J.suggestThemes(j, five).some(x => x.name === 'Work'));
});

test('filterEntries by theme, untagged, mode, words and range', () => {
  const j = seeded();
  assert.equal(J.filterEntries(j, { themeId: 'sample-t-work' }).length, 5);
  assert.deepEqual(J.filterEntries(j, { themeId: '__none' }).map(e => e.id), ['sample-6']);
  assert.equal(J.filterEntries(j, { mode: 'feel' }).length, 3);
  assert.deepEqual(J.filterEntries(j, { query: 'MANAGER check-in' }).map(e => e.id), ['sample-5']);
  const r = J.rangeFor('7', NOW);
  assert.deepEqual(J.filterEntries(j, r).map(e => e.id), ['sample-9', 'sample-8', 'sample-7', 'sample-6']);
});

test('summarize: every item has sources that exist, quotes are verbatim, no interpretation', () => {
  const j = seeded();
  const s = J.summarize(j, Object.assign({}, J.rangeFor('all', NOW)));
  assert.equal(s.entryCount, 9);
  assert.match(s.headline, /9 entries on 9 days/);
  const ids = new Set(j.entries.map(e => e.id));
  const allText = j.entries.map(J.entryText).join('\n');
  s.sections.forEach(sec => sec.items.forEach(it => {
    assert.ok(it.sources.length > 0, sec.id + ' item has a source');
    it.sources.forEach(id => assert.ok(ids.has(id)));
    if (it.quote) assert.ok(allText.includes(it.quote), 'quote is copied exactly');
    if (it.reframe) assert.ok(allText.includes(it.reframe));
  }));
  const feelings = s.sections.find(x => x.id === 'feelings');
  assert.equal(feelings.items[0].text, 'You named Anxious in 2 entries.');
  assert.deepEqual(feelings.items[0].sources, ['sample-6', 'sample-9']);
  const steps = s.sections.find(x => x.id === 'steps');
  assert.equal(steps.lead, 'You set 3 next steps (1 not marked yet, 1 did it, 1 partly).');
  // The generated wording must stay descriptive. These words would be interpretation.
  const generated = JSON.stringify(s.sections.map(sec => [sec.title, sec.lead, sec.items.map(i => i.text)]));
  ['depress', 'disorder', 'diagnos', 'symptom', 'you seem', 'you are feeling', 'should', 'score', 'streak'].forEach(w =>
    assert.ok(!generated.toLowerCase().includes(w), 'summary avoids "' + w + '"'));
  assert.match(s.limits, /does not interpret/);
});

test('summarize by theme and for an empty range', () => {
  const j = seeded();
  const s = J.summarize(j, { themeId: 'sample-t-sleep', label: 'all time' });
  assert.equal(s.entryCount, 3);
  assert.equal(s.themeName, 'Sleep');
  assert.ok(!s.sections.some(x => x.id === 'themes'));
  const none = J.summarize(J.emptyJournal(), J.rangeFor('7', NOW));
  assert.equal(none.entryCount, 0);
  assert.deepEqual(none.sections, []);
  assert.match(none.headline, /Nothing written/);
});

test('summarize ignores review entries so a look-back never counts itself', () => {
  let j = seeded();
  j = J.addReview(j, { answers: [{ prompt: 'q', answer: 'Anxious again', sources: ['sample-9'] }], now: NOW }).journal;
  assert.equal(J.summarize(j, {}).entryCount, 9);
});

test('reviewPrompts explain why, link sources, and never use streak or missed-day language', () => {
  const j = seeded();
  const p = J.reviewPrompts(j, NOW);
  assert.ok(p.length >= 3 && p.length <= 5);
  const ids = new Set(j.entries.map(e => e.id));
  p.forEach(x => {
    assert.ok(x.why && x.why.length > 10);
    assert.ok(x.sources.every(id => ids.has(id)));
    // Quoted words are the person's own; check only the wording the tool generates.
    const generated = x.text.replace(/"[^"]*"/g, '') + ' ' + x.why;
    assert.ok(!/streak|missed|behind|failed|should/i.test(generated), generated);
  });
  const step = p.find(x => x.kind === 'step');
  assert.equal(step.stepEntryId, 'sample-8');
  assert.equal(step.text, 'On Nov 6 you set a next step: "Call mom back on Saturday morning." How did it go? Any answer is fine, including "I let it go."');
  const feel = p.find(x => x.kind === 'feeling');
  assert.match(feel.text, /Anxious 2 times/);
  const theme = p.find(x => x.kind === 'theme');
  assert.match(theme.why, /Sleep is the theme you tagged most in the last 14 days \(2 entries\)/, 'ties break alphabetically');
});

test('reviewPrompts on an empty journal gives one open question', () => {
  const p = J.reviewPrompts(J.emptyJournal(), NOW);
  assert.equal(p.length, 1);
  assert.equal(p[0].kind, 'open');
  assert.deepEqual(p[0].sources, []);
});

test('a step marked as done drops out of review prompts', () => {
  let j = seeded();
  j = J.setStepStatus(j, 'sample-8', 'done', NOW).journal;
  assert.ok(!J.reviewPrompts(j, NOW).some(x => x.kind === 'step'));
  assert.ok(J.setStepStatus(j, 'sample-2', 'done', NOW).error, 'entries without a step are refused');
  assert.ok(J.setStepStatus(j, 'sample-8', 'whatever', NOW).error);
});

test('addReview needs at least one answer and links every source', () => {
  const j = seeded();
  assert.ok(J.addReview(j, { answers: [{ prompt: 'q', answer: '  ' }], now: NOW }).error);
  const r = J.addReview(j, { answers: [
    { prompt: 'A?', answer: 'Yes', sources: ['sample-1', 'ghost'] },
    { prompt: 'B?', answer: 'No', sources: ['sample-1', 'sample-2'] }
  ], now: NOW });
  assert.deepEqual(r.entry.sources, ['sample-1', 'sample-2']);
  assert.match(r.entry.fields.text, /Q: A\?\nA: Yes\n\nQ: B\?\nA: No/);
});

test('JSON export round-trips through import without loss', () => {
  let j = seeded();
  j = J.addReview(j, { answers: [{ prompt: 'q', answer: 'a', sources: ['sample-3'] }], now: NOW, id: 'rev' }).journal;
  const text = J.exportJSON(j, NOW);
  const back = J.parseImport(text);
  assert.ok(back.ok);
  assert.deepEqual(back.journal, j);
});

test('selective export keeps only chosen entries, their themes and internal links', () => {
  let j = seeded();
  j = J.addReview(j, { answers: [{ prompt: 'q', answer: 'a', sources: ['sample-3', 'sample-4'] }], now: NOW, id: 'rev' }).journal;
  const data = JSON.parse(J.exportJSON(j, NOW, { entryIds: ['rev', 'sample-4'] }));
  assert.deepEqual(data.journal.entries.map(e => e.id).sort(), ['rev', 'sample-4']);
  assert.deepEqual(data.journal.entries.find(e => e.id === 'rev').sources, ['sample-4']);
  assert.deepEqual(data.journal.themes.map(t => t.name), ['Sleep']);
  const md = J.exportMarkdown(j, NOW, { entryIds: ['sample-4'] });
  assert.match(md, /Could not sleep again/);
  assert.ok(!md.includes('quarterly report'));
});

test('Markdown export is readable and carries themes, feelings and step status', () => {
  const md = J.exportMarkdown(seeded(), NOW);
  assert.match(md, /^# Sounding Board journal/);
  assert.match(md, /9 entries/);
  assert.match(md, /Themes: Work, Sleep/);
  assert.match(md, /Feelings: Overwhelmed, Tired/);
  assert.match(md, /Step status: Did it/);
  assert.ok(md.indexOf('quarterly report') < md.indexOf('check-in'), 'oldest first');
});

test('parseImport rejects broken, foreign and newer files clearly', () => {
  assert.match(J.parseImport('{nope').error, /not valid JSON/);
  assert.match(J.parseImport('[1,2]').error, /does not contain a journal/);
  assert.match(J.parseImport(JSON.stringify({ kind: 'journal-export', version: 99, journal: {} })).error, /newer version/);
  const partly = J.parseImport(JSON.stringify({ entries: [
    { id: 'ok', mode: 'free', createdAt: '2026-11-01T10:00:00Z', fields: { text: 'hi' } },
    { id: 'bad-mode', mode: 'diagnosis', createdAt: '2026-11-01T10:00:00Z', fields: {} },
    { id: 'no-date', mode: 'free', fields: { text: 'x' } },
    'garbage'
  ] }));
  assert.ok(partly.ok);
  assert.equal(partly.journal.entries.length, 1);
  assert.match(partly.problems[0], /3 items were unreadable/);
});

test('mergeJournals skips duplicates and combines same-name themes', () => {
  const j = seeded();
  const incoming = {
    version: 1,
    themes: [{ id: 'other-work', name: 'WORK', keywords: ['boss'], createdAt: '2026-11-01T00:00:00Z' }],
    entries: [
      J.getEntry(j, 'sample-1'),
      { id: 'new-1', mode: 'free', createdAt: '2026-11-08T10:00:00Z', updatedAt: '2026-11-08T10:00:00Z', fields: { text: 'From my other phone' }, feelings: [], themeIds: ['other-work'], sources: [] }
    ]
  };
  const m = J.mergeJournals(j, J.normalize(incoming).journal);
  assert.equal(m.added, 1);
  assert.equal(m.skipped, 1);
  assert.equal(m.themesAdded, 0);
  assert.deepEqual(J.getEntry(m.journal, 'new-1').themeIds, ['sample-t-work']);
  assert.ok(m.journal.themes.find(t => t.id === 'sample-t-work').keywords.includes('boss'));
});

test('removeSamples takes out sample entries and themes but keeps real writing and its themes', () => {
  let j = seeded();
  j = J.addEntry(j, { mode: 'free', fields: { text: 'Mine' }, themeIds: ['sample-t-sleep'], now: NOW, id: 'mine' }).journal;
  const r = J.removeSamples(j);
  assert.equal(r.removed, 9);
  assert.deepEqual(r.journal.entries.map(e => e.id), ['mine']);
  assert.deepEqual(r.journal.themes.map(t => t.name), ['Sleep'], 'a sample theme the person used stays');
});

test('safetyCheck points to crisis resources only for clear phrases', () => {
  assert.equal(J.safetyCheck('Some days I want to die'), true);
  assert.equal(J.safetyCheck('thinking about suicide'), true);
  assert.equal(J.safetyCheck('I keep wanting to hurt myself'), true);
  assert.equal(J.safetyCheck('This deadline is killing me'), false);
  assert.equal(J.safetyCheck('I want to end the meeting early'), false);
});

test('load and save: fresh, round trip, and storage that throws', () => {
  const s = memStorage();
  const first = J.load(s, NOW);
  assert.equal(first.persistent, true);
  assert.equal(first.journal.entries.length, 0);
  const j = seeded();
  assert.ok(J.save(s, j).ok);
  assert.deepEqual(J.load(s, NOW).journal, j);

  const blocked = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('x'); }, removeItem() {} };
  const b = J.load(blocked, NOW);
  assert.equal(b.persistent, false);
  assert.match(b.notices[0], /only while this tab is open/);
  assert.equal(J.load(null, NOW).persistent, false);

  const full = { setItem() { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; } };
  assert.match(J.save(full, j).error, /out of room/);
});

test('corrupt storage is kept aside, not overwritten, and the readable part survives', () => {
  const s = memStorage({ [J.STORAGE_KEY]: '{"version":1,"entries":[{"id":"a"' });
  const r = J.load(s, NOW);
  assert.equal(r.journal.entries.length, 0);
  assert.ok(r.corruptKey);
  assert.equal(s.getItem(r.corruptKey), '{"version":1,"entries":[{"id":"a"');
  assert.match(r.notices.join(' '), /kept aside/);
  assert.deepEqual(J.corruptBackups(s), [r.corruptKey]);

  const partial = memStorage({ [J.STORAGE_KEY]: JSON.stringify({ version: 1, themes: [], entries: [
    { id: 'good', mode: 'free', createdAt: '2026-11-01T10:00:00Z', fields: { text: 'keep me' } },
    { id: 'bad', mode: 'free', createdAt: 'not a date', fields: { text: 'x' } }
  ] }) });
  const p = J.load(partial, NOW);
  assert.deepEqual(p.journal.entries.map(e => e.id), ['good']);
  assert.ok(p.corruptKey, 'the original is kept because something was dropped');
});

test('a damaged journal is kept aside once, not again on every reload', () => {
  const raw = '{"version":1,"entries":[{"id":"a"';
  const s = memStorage({ [J.STORAGE_KEY]: raw });
  J.load(s, NOW);
  J.load(s, NOW + 1000);
  J.load(s, NOW + 2000);
  assert.equal(J.corruptBackups(s).length, 1, 'one copy aside, not one per reload');
  assert.equal(s.getItem(J.corruptBackups(s)[0]), raw);

  const partial = memStorage({ [J.STORAGE_KEY]: JSON.stringify({ version: 1, themes: [], entries: [
    { id: 'good', mode: 'free', createdAt: '2026-11-01T10:00:00Z', fields: { text: 'keep me' } },
    { id: 'bad', mode: 'free', createdAt: 'not a date', fields: { text: 'x' } }
  ] }) });
  J.load(partial, NOW);
  const again = J.load(partial, NOW + 1000);
  assert.deepEqual(again.journal.entries.map(e => e.id), ['good'], 'the readable part was stored');
  assert.equal(again.corruptKey, null);
  assert.equal(J.corruptBackups(partial).length, 1);
});

test('data from a newer version is never overwritten', () => {
  const raw = JSON.stringify({ version: 7, entries: [] });
  const s = memStorage({ [J.STORAGE_KEY]: raw });
  const r = J.load(s, NOW);
  assert.equal(r.persistent, false);
  assert.match(r.notices[0], /newer version/);
  assert.equal(s.getItem(J.STORAGE_KEY), raw);
});

test('drafts from the earlier version are migrated once and their keys removed', () => {
  const s = memStorage({
    'sb-untangle': JSON.stringify(['It rained on the picnic', 'Ruined', '', '', '', 'Reschedule']),
    'sb-feel': JSON.stringify(['I need rest']),
    'sb-good': JSON.stringify(['', '', '']),
    'unrelated': 'keep'
  });
  const r = J.load(s, NOW);
  assert.deepEqual(r.journal.entries.map(e => e.mode).sort(), ['feel', 'untangle']);
  const u = r.journal.entries.find(e => e.mode === 'untangle');
  assert.equal(u.fields.happened, 'It rained on the picnic');
  assert.equal(u.fields.step, 'Reschedule');
  assert.equal(u.step.status, 'open');
  assert.match(r.notices.join(' '), /Brought 2 earlier saved drafts/);
  assert.equal(s.getItem('sb-untangle'), null);
  assert.equal(s.getItem('unrelated'), 'keep');
  assert.equal(J.load(s, NOW + 1000).journal.entries.length, 2, 'second load does not duplicate');
});

test('wipe removes the journal, legacy drafts and corrupt backups, and nothing else', () => {
  const s = memStorage({
    [J.STORAGE_KEY]: '{}', 'sb-feel': '[]', [J.CORRUPT_PREFIX + '1']: 'x', [J.CORRUPT_PREFIX + '2']: 'y', 'other-site-thing': 'keep'
  });
  const w = J.wipe(s);
  assert.equal(w.removed, 4);
  assert.deepEqual(Object.keys(s.dump()), ['other-site-thing']);
});

test('dayKey and shortDate use local calendar days', () => {
  assert.equal(J.dayKey('2026-11-09T23:30:00Z'), '2026-11-09');
  assert.equal(J.shortDate('2026-03-04T12:00:00Z'), 'Mar 4');
});
