/*
  Sounding Board journal core.

  Plain script, no dependencies, no network. It runs in the page (as window.SBJournal)
  and in Node for tests (module.exports). Every function that changes the journal
  returns a new journal object; nothing here touches the DOM.

  Ground rules this file enforces:
  - Summaries and review prompts only repeat, count and link back to what the person
    wrote. They never interpret, diagnose or score.
  - Themes belong to the person. Keyword matches are suggestions with a stated reason,
    never automatic assignments.
  - Storage problems never destroy writing: corrupt data is kept aside, and an
    unavailable store falls back to memory with a visible warning.
*/
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SBJournal = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCHEMA_VERSION = 1;
  const STORAGE_KEY = 'sb-journal-v1';
  const CORRUPT_PREFIX = 'sb-journal-corrupt-';
  const LEGACY_KEYS = ['sb-untangle', 'sb-feel', 'sb-good'];
  const DAY = 86400000;

  const MODES = {
    untangle: {
      label: 'Untangled a moment',
      fields: [
        { key: 'happened', label: 'What happened' },
        { key: 'thought', label: 'What went through my mind' },
        { key: 'felt', label: 'How it felt, and where' },
        { key: 'friend', label: 'What I would tell a friend' },
        { key: 'kinder', label: 'A kinder, truer way to hold it' },
        { key: 'step', label: 'One small next step' }
      ]
    },
    feel: {
      label: 'Named a feeling',
      fields: [{ key: 'pointing', label: 'What it might be pointing to' }]
    },
    good: {
      label: "What's going right",
      fields: [
        { key: 'okay', label: 'One thing that went okay' },
        { key: 'glad', label: "One person or thing I'm glad exists" },
        { key: 'handled', label: 'One thing I handled' }
      ]
    },
    free: {
      label: 'Note',
      fields: [{ key: 'text', label: 'Note' }]
    },
    review: {
      label: 'Look-back review',
      fields: [{ key: 'text', label: 'Review' }]
    }
  };

  const FEELINGS = ['Anxious', 'Overwhelmed', 'Sad', 'Lonely', 'Angry', 'Frustrated', 'Ashamed', 'Numb',
    'Tired', 'Scared', 'Hurt', 'Restless', 'Hopeful', 'Relieved', 'Calm', 'Grateful'];

  const STEP_STATUSES = {
    open: 'Not marked yet',
    done: 'Did it',
    partly: 'Partly',
    'let-go': 'Let it go'
  };

  const SUMMARY_LIMITS = 'This look-back only repeats, counts and links to what you wrote. ' +
    'It does not interpret your entries, judge them, or say anything about your health. ' +
    'Counts show how often you wrote something down, not how often it happened.';

  // Phrases that suggest someone may be thinking about harming themselves. A match only
  // shows a gentle pointer to the crisis resources; it never blocks, stores or labels anything.
  const SAFETY_PATTERNS = [
    /\bkill(ing)? myself\b/i, /\bsuicid(e|al)\b/i, /\bend (it all|my life)\b/i,
    /\bself[- ]?harm\b/i, /\bhurt(ing)? myself\b/i, /\bwant to die\b/i,
    /\bno reason to (live|go on)\b/i, /\bbetter off without me\b/i, /\bcut(ting)? myself\b/i
  ];

  // ---------- small helpers ----------

  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function str(x) { return typeof x === 'string' ? x : ''; }
  function iso(now) { return new Date(now).toISOString(); }
  function ms(isoString) { const t = Date.parse(isoString); return Number.isFinite(t) ? t : NaN; }

  let idCounter = 0;
  function makeId(prefix, now) {
    idCounter = (idCounter + 1) % 1679616;
    const rand = Math.floor(Math.random() * 1679616).toString(36);
    return prefix + '_' + Math.floor(now).toString(36) + idCounter.toString(36) + rand;
  }

  /** Local calendar day, YYYY-MM-DD, in the device's time zone. */
  function dayKey(isoString) {
    const d = new Date(isoString);
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /** Short readable date such as "Nov 3", in local time. */
  function shortDate(isoString) {
    const d = new Date(isoString);
    return MONTHS[d.getMonth()] + ' ' + d.getDate();
  }

  function emptyJournal() {
    return { version: SCHEMA_VERSION, entries: [], themes: [] };
  }

  function cleanFields(mode, fields) {
    const out = {};
    const def = MODES[mode];
    const src = isObj(fields) ? fields : {};
    def.fields.forEach(f => {
      const v = str(src[f.key]).replace(/\r\n/g, '\n');
      if (v.trim()) out[f.key] = v;
    });
    return out;
  }

  function cleanFeelings(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    return list.map(str).map(s => s.trim()).filter(s => s && s.length <= 40 && !seen.has(s) && seen.add(s));
  }

  function entryHasContent(e) {
    return Object.keys(e.fields).length > 0 || e.feelings.length > 0;
  }

  /** All the text a person wrote in an entry, for search and keyword matching. */
  function entryText(e) {
    return Object.values(e.fields).join('\n') + (e.feelings.length ? '\n' + e.feelings.join(' ') : '');
  }

  function sortEntries(entries) {
    return entries.slice().sort((a, b) => ms(b.createdAt) - ms(a.createdAt) || (a.id < b.id ? 1 : -1));
  }

  // ---------- validation and migration ----------

  /**
   * Turn anything that claims to be a journal into a valid one. Invalid items are dropped
   * and counted so the interface can say so; nothing is silently invented.
   */
  function normalize(raw) {
    const problems = [];
    if (!isObj(raw)) return { journal: emptyJournal(), problems: ['The data was not a journal.'], dropped: 0 };
    const version = raw.version === undefined ? 1 : raw.version;
    if (typeof version !== 'number' || version > SCHEMA_VERSION) {
      return { journal: emptyJournal(), problems: ['This journal was made by a newer version of Sounding Board (version ' + String(version) + ').'], dropped: 0, tooNew: true };
    }
    const j = emptyJournal();
    let dropped = 0;
    const themeIds = new Set();
    (Array.isArray(raw.themes) ? raw.themes : []).forEach(t => {
      if (!isObj(t) || !str(t.id) || !str(t.name).trim() || themeIds.has(t.id)) { dropped++; return; }
      themeIds.add(t.id);
      j.themes.push({
        id: t.id,
        name: str(t.name).trim().slice(0, 60),
        keywords: cleanKeywords(t.keywords),
        createdAt: Number.isFinite(ms(t.createdAt)) ? t.createdAt : iso(0)
      });
      if (t.sample === true) j.themes[j.themes.length - 1].sample = true;
    });
    const entryIds = new Set();
    (Array.isArray(raw.entries) ? raw.entries : []).forEach(e => {
      if (!isObj(e) || !str(e.id) || entryIds.has(e.id) || !MODES[e.mode] || !Number.isFinite(ms(e.createdAt))) { dropped++; return; }
      const entry = {
        id: e.id,
        mode: e.mode,
        createdAt: e.createdAt,
        updatedAt: Number.isFinite(ms(e.updatedAt)) ? e.updatedAt : e.createdAt,
        fields: cleanFields(e.mode, e.fields),
        feelings: cleanFeelings(e.feelings),
        themeIds: (Array.isArray(e.themeIds) ? e.themeIds : []).filter(id => themeIds.has(id)),
        sources: Array.isArray(e.sources) ? e.sources.filter(s => typeof s === 'string') : []
      };
      entry.themeIds = Array.from(new Set(entry.themeIds));
      if (e.mode === 'untangle' && entry.fields.step) {
        const st = isObj(e.step) && STEP_STATUSES[e.step.status] ? e.step.status : 'open';
        entry.step = { status: st, updatedAt: isObj(e.step) && Number.isFinite(ms(e.step.updatedAt)) ? e.step.updatedAt : entry.createdAt };
      }
      if (e.sample === true) entry.sample = true;
      if (!entryHasContent(entry)) { dropped++; return; }
      entryIds.add(entry.id);
      j.entries.push(entry);
    });
    // Review links may only point at entries that exist.
    j.entries.forEach(e => { e.sources = e.sources.filter(id => entryIds.has(id) && id !== e.id); });
    j.entries = sortEntries(j.entries);
    if (dropped) problems.push(dropped + ' item' + (dropped === 1 ? ' was' : 's were') + ' unreadable and left out.');
    return { journal: j, problems, dropped };
  }

  function cleanKeywords(list) {
    const arr = Array.isArray(list) ? list : (typeof list === 'string' ? list.split(',') : []);
    const seen = new Set();
    return arr.map(str).map(s => s.trim().toLowerCase()).filter(s => s && s.length <= 40 && !seen.has(s) && seen.add(s)).slice(0, 20);
  }

  /**
   * The first version of the tool saved one draft per mode under sb-untangle, sb-feel and
   * sb-good (arrays of textarea values). Turn any of those into journal entries once.
   */
  function legacyEntries(getItem, now) {
    const out = [];
    const order = { 'sb-untangle': 'untangle', 'sb-feel': 'feel', 'sb-good': 'good' };
    Object.keys(order).forEach((key, i) => {
      let raw;
      try { raw = getItem(key); } catch (err) { return; }
      if (!raw) return;
      let values;
      try { values = JSON.parse(raw); } catch (err) { return; }
      if (!Array.isArray(values)) return;
      const mode = order[key];
      const fields = {};
      MODES[mode].fields.forEach((f, idx) => { fields[f.key] = str(values[idx]); });
      const entry = buildEntry({ mode, fields, now: now - (2 - i), id: 'legacy-' + mode });
      if (entryHasContent(entry)) out.push(entry);
    });
    return out;
  }

  // ---------- entries ----------

  function buildEntry({ mode, fields, feelings, themeIds, sources, now, id }) {
    if (!MODES[mode]) throw new Error('Unknown mode: ' + mode);
    const t = iso(now);
    const entry = {
      id: id || makeId('e', now),
      mode,
      createdAt: t,
      updatedAt: t,
      fields: cleanFields(mode, fields),
      feelings: mode === 'feel' ? cleanFeelings(feelings) : [],
      themeIds: Array.isArray(themeIds) ? Array.from(new Set(themeIds)) : [],
      sources: Array.isArray(sources) ? Array.from(new Set(sources)) : []
    };
    if (mode === 'untangle' && entry.fields.step) entry.step = { status: 'open', updatedAt: t };
    return entry;
  }

  /** Add an entry. Returns { journal, entry } or { error } when there is nothing to save. */
  function addEntry(journal, input) {
    const entry = buildEntry(input);
    if (!entryHasContent(entry)) return { error: 'Nothing to save yet. Write something first.' };
    const known = new Set(journal.themes.map(t => t.id));
    entry.themeIds = entry.themeIds.filter(id => known.has(id));
    const ids = new Set(journal.entries.map(e => e.id));
    entry.sources = entry.sources.filter(id => ids.has(id));
    const j = clone(journal);
    j.entries = sortEntries(j.entries.concat([entry]));
    return { journal: j, entry };
  }

  function getEntry(journal, id) { return journal.entries.find(e => e.id === id) || null; }

  /** Edit an entry's text or feelings. Clearing every field is refused; delete instead. */
  function updateEntry(journal, id, patch, now) {
    const j = clone(journal);
    const e = j.entries.find(x => x.id === id);
    if (!e) return { error: 'That entry no longer exists.' };
    const next = Object.assign({}, e);
    if (patch.fields) next.fields = cleanFields(e.mode, patch.fields);
    if (patch.feelings && e.mode === 'feel') next.feelings = cleanFeelings(patch.feelings);
    if (!entryHasContent(next)) return { error: 'An entry needs some writing. To remove it, use Delete.' };
    if (e.mode === 'untangle') {
      if (next.fields.step && !e.step) next.step = { status: 'open', updatedAt: iso(now) };
      if (!next.fields.step) delete next.step;
    }
    next.updatedAt = iso(now);
    j.entries[j.entries.indexOf(e)] = next;
    return { journal: j, entry: next };
  }

  /** Remove an entry, and any review links that pointed at it. Returns the removed entry for undo. */
  function deleteEntry(journal, id) {
    const removed = getEntry(journal, id);
    if (!removed) return { journal, removed: null };
    const j = clone(journal);
    j.entries = j.entries.filter(e => e.id !== id);
    j.entries.forEach(e => { e.sources = e.sources.filter(s => s !== id); });
    return { journal: j, removed: clone(removed) };
  }

  /** Put back an entry removed by deleteEntry (undo). Theme links to deleted themes are dropped. */
  function restoreEntry(journal, entry) {
    if (!entry || getEntry(journal, entry.id)) return { journal };
    const j = clone(journal);
    const e = clone(entry);
    const known = new Set(j.themes.map(t => t.id));
    e.themeIds = e.themeIds.filter(id => known.has(id));
    const ids = new Set(j.entries.map(x => x.id));
    e.sources = e.sources.filter(id => ids.has(id));
    j.entries = sortEntries(j.entries.concat([e]));
    return { journal: j, entry: e };
  }

  function setStepStatus(journal, id, status, now) {
    if (!STEP_STATUSES[status]) return { error: 'Unknown status.' };
    const j = clone(journal);
    const e = j.entries.find(x => x.id === id);
    if (!e || !e.step) return { error: 'That entry has no next step.' };
    e.step = { status, updatedAt: iso(now) };
    return { journal: j, entry: e };
  }

  // ---------- themes ----------

  function addTheme(journal, { name, keywords, now, id }) {
    const n = str(name).trim().slice(0, 60);
    if (!n) return { error: 'Give the theme a name.' };
    if (journal.themes.some(t => t.name.toLowerCase() === n.toLowerCase())) return { error: 'You already have a theme called "' + n + '".' };
    const theme = { id: id || makeId('t', now), name: n, keywords: cleanKeywords(keywords), createdAt: iso(now) };
    const j = clone(journal);
    j.themes.push(theme);
    return { journal: j, theme };
  }

  function updateTheme(journal, id, { name, keywords }) {
    const j = clone(journal);
    const t = j.themes.find(x => x.id === id);
    if (!t) return { error: 'That theme no longer exists.' };
    if (name !== undefined) {
      const n = str(name).trim().slice(0, 60);
      if (!n) return { error: 'A theme needs a name.' };
      if (j.themes.some(x => x.id !== id && x.name.toLowerCase() === n.toLowerCase())) return { error: 'You already have a theme called "' + n + '".' };
      t.name = n;
    }
    if (keywords !== undefined) t.keywords = cleanKeywords(keywords);
    return { journal: j, theme: t };
  }

  /** Delete a theme. Entries stay; they just lose that tag. */
  function deleteTheme(journal, id) {
    const j = clone(journal);
    const before = j.themes.length;
    j.themes = j.themes.filter(t => t.id !== id);
    let untagged = 0;
    j.entries.forEach(e => {
      const n = e.themeIds.length;
      e.themeIds = e.themeIds.filter(x => x !== id);
      if (e.themeIds.length !== n) untagged++;
    });
    return { journal: j, removed: before !== j.themes.length, untagged };
  }

  function setEntryTheme(journal, entryId, themeId, on) {
    const j = clone(journal);
    const e = j.entries.find(x => x.id === entryId);
    if (!e) return { error: 'That entry no longer exists.' };
    if (!j.themes.some(t => t.id === themeId)) return { error: 'That theme no longer exists.' };
    const has = e.themeIds.includes(themeId);
    if (on && !has) e.themeIds.push(themeId);
    if (!on && has) e.themeIds = e.themeIds.filter(x => x !== themeId);
    return { journal: j, entry: e };
  }

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /**
   * Themes this entry might belong to, based only on the keywords the person gave each
   * theme. Returns the matched words so the interface can say why.
   */
  function suggestThemes(journal, entry) {
    if (!entry) return [];
    const text = entryText(entry);
    return journal.themes
      .filter(t => !entry.themeIds.includes(t.id) && t.keywords.length)
      .map(t => ({
        themeId: t.id,
        name: t.name,
        matched: t.keywords.filter(k => new RegExp('(^|[^\\p{L}\\p{N}])' + escapeRe(k) + '($|[^\\p{L}\\p{N}])', 'iu').test(text))
      }))
      .filter(s => s.matched.length);
  }

  // ---------- finding entries ----------

  function inRange(e, from, to) {
    const t = ms(e.createdAt);
    return (from == null || t >= from) && (to == null || t <= to);
  }

  /** Filter by theme, mode, words and date range. Newest first. */
  function filterEntries(journal, { themeId, mode, query, from, to } = {}) {
    const words = str(query).toLowerCase().split(/\s+/).filter(Boolean);
    return journal.entries.filter(e => {
      if (themeId === '__none') { if (e.themeIds.length) return false; }
      else if (themeId && !e.themeIds.includes(themeId)) return false;
      if (mode && e.mode !== mode) return false;
      if (!inRange(e, from, to)) return false;
      if (words.length) {
        const text = entryText(e).toLowerCase();
        if (!words.every(w => text.includes(w))) return false;
      }
      return true;
    });
  }

  function rangeFor(key, now) {
    if (key === '7') return { from: now - 7 * DAY, to: now, label: 'the last 7 days' };
    if (key === '30') return { from: now - 30 * DAY, to: now, label: 'the last 30 days' };
    return { from: null, to: null, label: 'all time' };
  }

  // ---------- look-back summary ----------

  /** Quote the person's words and continue the sentence without doubling their punctuation. */
  function quoteThen(text, next) {
    const t = str(text).trim();
    return '"' + t + '"' + (/[.!?]$/.test(t) ? ' ' : '. ') + next;
  }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  /**
   * A source-linked look-back. Every item carries the ids of the entries it came from, and
   * quoted text is copied exactly. No item is produced without at least one source.
   */
  function summarize(journal, { from = null, to = null, themeId = null, label = '' } = {}) {
    const entries = filterEntries(journal, { from, to, themeId }).filter(e => e.mode !== 'review');
    const chrono = entries.slice().reverse();
    const sections = [];

    // Feelings named, most often first, ties alphabetical.
    const feelMap = new Map();
    chrono.forEach(e => e.feelings.forEach(f => {
      if (!feelMap.has(f)) feelMap.set(f, []);
      feelMap.get(f).push(e.id);
    }));
    const feelItems = Array.from(feelMap.entries())
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([f, ids]) => ({ text: 'You named ' + f + ' in ' + plural(ids.length, 'entry', 'entries') + '.', sources: ids }));
    if (feelItems.length) sections.push({ id: 'feelings', title: 'Feelings you named', items: feelItems });

    // Thoughts worked through: the thought and the kinder version, side by side, in your words.
    const thoughtItems = chrono.filter(e => e.mode === 'untangle' && (e.fields.thought || e.fields.kinder)).map(e => ({
      quote: e.fields.thought || '',
      reframe: e.fields.kinder || '',
      text: e.fields.thought && e.fields.kinder ? 'A thought, and the fairer way you found to hold it.'
        : e.fields.thought ? 'A thought you wrote down.' : 'A fairer way you found to hold something.',
      sources: [e.id]
    }));
    if (thoughtItems.length) sections.push({ id: 'thoughts', title: 'Thoughts you worked through', items: thoughtItems });

    // Next steps, with whatever status you marked.
    const steps = chrono.filter(e => e.step);
    if (steps.length) {
      const counts = {};
      steps.forEach(e => { counts[e.step.status] = (counts[e.step.status] || 0) + 1; });
      const tally = Object.keys(STEP_STATUSES).filter(k => counts[k]).map(k => counts[k] + ' ' + STEP_STATUSES[k].toLowerCase()).join(', ');
      sections.push({
        id: 'steps',
        title: 'Next steps you set',
        lead: 'You set ' + plural(steps.length, 'next step') + ' (' + tally + ').',
        items: steps.map(e => ({ quote: e.fields.step, status: e.step.status, text: STEP_STATUSES[e.step.status], sources: [e.id] }))
      });
    }

    // What went right, in your words.
    const goodItems = [];
    chrono.filter(e => e.mode === 'good').forEach(e => {
      MODES.good.fields.forEach(f => { if (e.fields[f.key]) goodItems.push({ quote: e.fields[f.key], text: f.label, sources: [e.id] }); });
    });
    if (goodItems.length) sections.push({ id: 'good', title: 'Things that went right', items: goodItems });

    // What feelings pointed to.
    const pointItems = chrono.filter(e => e.mode === 'feel' && e.fields.pointing).map(e => ({
      quote: e.fields.pointing, text: e.feelings.length ? 'Under ' + e.feelings.join(', ') : 'What a feeling pointed to', sources: [e.id]
    }));
    if (pointItems.length) sections.push({ id: 'pointing', title: 'What your feelings pointed to', items: pointItems });

    // Themes you tagged.
    if (!themeId) {
      const themeItems = journal.themes.map(t => ({ t, ids: chrono.filter(e => e.themeIds.includes(t.id)).map(e => e.id) }))
        .filter(x => x.ids.length)
        .sort((a, b) => b.ids.length - a.ids.length || a.t.name.localeCompare(b.t.name))
        .map(x => ({ text: x.t.name + ': ' + plural(x.ids.length, 'entry', 'entries') + ' tagged.', themeId: x.t.id, sources: x.ids }));
      if (themeItems.length) sections.push({ id: 'themes', title: 'Themes you tagged', items: themeItems });
    }

    const theme = themeId ? journal.themes.find(t => t.id === themeId) : null;
    const days = new Set(entries.map(e => dayKey(e.createdAt)));
    return {
      label: label || 'all time',
      themeName: theme ? theme.name : null,
      entryCount: entries.length,
      dayCount: days.size,
      headline: entries.length
        ? 'In ' + (label || 'all time') + (theme ? ', tagged ' + theme.name : '') + ', you wrote ' + plural(entries.length, 'entry', 'entries') + ' on ' + plural(days.size, 'day') + '.'
        : 'Nothing written in ' + (label || 'all time') + (theme ? ' tagged ' + theme.name : '') + ' yet.',
      sections,
      limits: SUMMARY_LIMITS
    };
  }

  // ---------- review prompts ----------

  /**
   * Questions to look back with. Each says why it was chosen and which entries it came
   * from. Nothing here counts days in a row or marks anything as missed.
   */
  function reviewPrompts(journal, now, { windowDays = 14, max = 5 } = {}) {
    const from = now - windowDays * DAY;
    const recent = journal.entries.filter(e => e.mode !== 'review' && inRange(e, from, now));
    const prompts = [];

    // Open next steps at least a day old, oldest first.
    journal.entries.filter(e => e.step && e.step.status === 'open' && now - ms(e.createdAt) >= DAY)
      .slice().reverse().slice(0, 2).forEach(e => {
        prompts.push({
          id: 'step:' + e.id,
          kind: 'step',
          text: 'On ' + shortDate(e.createdAt) + ' you set a next step: ' + quoteThen(e.fields.step, 'How did it go? Any answer is fine, including "I let it go."'),
          why: 'You set this step and have not marked how it went.',
          sources: [e.id],
          stepEntryId: e.id
        });
      });

    // A feeling named more than once recently.
    const feelMap = new Map();
    recent.slice().reverse().forEach(e => e.feelings.forEach(f => { if (!feelMap.has(f)) feelMap.set(f, []); feelMap.get(f).push(e.id); }));
    const repeated = Array.from(feelMap.entries()).filter(([, ids]) => ids.length >= 2)
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
    if (repeated) {
      prompts.push({
        id: 'feeling:' + repeated[0],
        kind: 'feeling',
        text: 'You named ' + repeated[0] + ' ' + repeated[1].length + ' times lately. Looking at those entries, was anything similar going on around them?',
        why: 'You picked ' + repeated[0] + ' in ' + repeated[1].length + ' entries in the last ' + windowDays + ' days.',
        sources: repeated[1]
      });
    }

    // The theme you tagged most recently-often.
    const themeCounts = journal.themes.map(t => ({ t, ids: recent.filter(e => e.themeIds.includes(t.id)).map(e => e.id).reverse() }))
      .filter(x => x.ids.length >= 2)
      .sort((a, b) => b.ids.length - a.ids.length || a.t.name.localeCompare(b.t.name));
    if (themeCounts.length) {
      const top = themeCounts[0];
      prompts.push({
        id: 'theme:' + top.t.id,
        kind: 'theme',
        text: 'Reading back your ' + top.t.name + ' entries, what do you notice now that you did not see at the time?',
        why: top.t.name + ' is the theme you tagged most in the last ' + windowDays + ' days (' + top.ids.length + ' entries).',
        sources: top.ids
      });
    }

    // A thought you reframed: does the kinder version still fit?
    const reframed = recent.filter(e => e.mode === 'untangle' && e.fields.kinder)[0];
    if (reframed) {
      prompts.push({
        id: 'reframe:' + reframed.id,
        kind: 'reframe',
        text: 'On ' + shortDate(reframed.createdAt) + ' you wrote: ' + quoteThen(reframed.fields.kinder, 'Does that still feel true, or would you put it differently now?'),
        why: 'This is the most recent kinder way of holding something that you wrote down.',
        sources: [reframed.id]
      });
    }

    // Something that went right, if there is one.
    const good = recent.filter(e => e.mode === 'good')[0];
    if (good) {
      const k = good.fields.handled ? 'handled' : good.fields.okay ? 'okay' : 'glad';
      prompts.push({
        id: 'good:' + good.id,
        kind: 'good',
        text: 'On ' + shortDate(good.createdAt) + ' you wrote: ' + quoteThen(good.fields[k], 'What made that possible?'),
        why: 'You noted this as something that went right.',
        sources: [good.id]
      });
    }

    if (!prompts.length) {
      prompts.push({
        id: 'open',
        kind: 'open',
        text: recent.length ? 'Reading back over the last couple of weeks, what stands out to you?' : 'What has been on your mind lately?',
        why: recent.length ? 'A general question; nothing more specific stood out in your recent entries.' : 'You have no entries in the last ' + windowDays + ' days, so this is a general starting question.',
        sources: recent.map(e => e.id).slice(0, 5)
      });
    }
    return prompts.slice(0, max);
  }

  /** Save answered review prompts as one review entry linked to every source entry. */
  function addReview(journal, { answers, now, id }) {
    const parts = [];
    const sources = [];
    (Array.isArray(answers) ? answers : []).forEach(a => {
      const text = str(a.answer).trim();
      if (!text) return;
      parts.push('Q: ' + str(a.prompt) + '\nA: ' + text);
      (a.sources || []).forEach(s => { if (!sources.includes(s)) sources.push(s); });
    });
    if (!parts.length) return { error: 'Answer at least one question to save a review.' };
    return addEntry(journal, { mode: 'review', fields: { text: parts.join('\n\n') }, sources, now, id });
  }

  // ---------- export and import ----------

  function exportJSON(journal, now, { entryIds } = {}) {
    let j = clone(journal);
    if (entryIds) {
      const keep = new Set(entryIds);
      j.entries = j.entries.filter(e => keep.has(e.id));
      j.entries.forEach(e => { e.sources = e.sources.filter(s => keep.has(s)); });
      const used = new Set();
      j.entries.forEach(e => e.themeIds.forEach(t => used.add(t)));
      j.themes = j.themes.filter(t => used.has(t.id));
    }
    return JSON.stringify({ app: 'sounding-board', kind: 'journal-export', version: SCHEMA_VERSION, exportedAt: iso(now), journal: j }, null, 2);
  }

  /** Plain, readable text version of entries (Markdown). */
  function exportMarkdown(journal, now, { entryIds } = {}) {
    const keep = entryIds ? new Set(entryIds) : null;
    const entries = journal.entries.filter(e => !keep || keep.has(e.id)).slice().reverse();
    const themeName = id => (journal.themes.find(t => t.id === id) || {}).name;
    const lines = ['# Sounding Board journal', '', 'Exported ' + iso(now) + '. ' + plural(entries.length, 'entry', 'entries') + '. Private: written on your own device.', ''];
    entries.forEach(e => {
      lines.push('## ' + dayKey(e.createdAt) + ', ' + MODES[e.mode].label);
      const tags = e.themeIds.map(themeName).filter(Boolean);
      if (tags.length) lines.push('Themes: ' + tags.join(', '));
      if (e.feelings.length) lines.push('Feelings: ' + e.feelings.join(', '));
      MODES[e.mode].fields.forEach(f => {
        if (!e.fields[f.key]) return;
        if (e.mode === 'free' || e.mode === 'review') lines.push('', e.fields[f.key]);
        else lines.push('', '**' + f.label + '**', e.fields[f.key]);
      });
      if (e.step) lines.push('', 'Step status: ' + STEP_STATUSES[e.step.status]);
      if (e.sources.length) {
        const refs = e.sources.map(id => getEntry(journal, id)).filter(Boolean).map(s => dayKey(s.createdAt) + ' (' + MODES[s.mode].label + ')');
        if (refs.length) lines.push('', 'Looks back at: ' + refs.join('; '));
      }
      lines.push('');
    });
    return lines.join('\n');
  }

  /** Read an export file. Accepts the export envelope or a bare journal object. */
  function parseImport(text) {
    let data;
    try { data = JSON.parse(text); } catch (err) { return { ok: false, error: 'That file is not a Sounding Board export (it is not valid JSON).' }; }
    let raw = data;
    if (isObj(data) && data.kind === 'journal-export') {
      if (typeof data.version === 'number' && data.version > SCHEMA_VERSION) return { ok: false, error: 'That export came from a newer version of Sounding Board.' };
      raw = data.journal;
    }
    if (!isObj(raw) || (!Array.isArray(raw.entries) && !Array.isArray(raw.themes))) return { ok: false, error: 'That file does not contain a journal.' };
    const n = normalize(raw);
    if (n.tooNew) return { ok: false, error: n.problems[0] };
    return { ok: true, journal: n.journal, problems: n.problems };
  }

  /**
   * Merge an imported journal into the current one. Entries already present (same id) are
   * kept as they are here. Themes with the same name are combined.
   */
  function mergeJournals(current, incoming) {
    const j = clone(current);
    const themeMap = {};
    let themesAdded = 0;
    incoming.themes.forEach(t => {
      const same = j.themes.find(x => x.id === t.id) || j.themes.find(x => x.name.toLowerCase() === t.name.toLowerCase());
      if (same) {
        themeMap[t.id] = same.id;
        same.keywords = cleanKeywords(same.keywords.concat(t.keywords));
      } else {
        j.themes.push(clone(t));
        themeMap[t.id] = t.id;
        themesAdded++;
      }
    });
    const have = new Set(j.entries.map(e => e.id));
    let added = 0, skipped = 0;
    incoming.entries.forEach(e => {
      if (have.has(e.id)) { skipped++; return; }
      const c = clone(e);
      c.themeIds = Array.from(new Set(c.themeIds.map(id => themeMap[id]).filter(Boolean)));
      j.entries.push(c);
      have.add(c.id);
      added++;
    });
    j.entries.forEach(e => { e.sources = e.sources.filter(s => have.has(s)); });
    j.entries = sortEntries(j.entries);
    return { journal: j, added, skipped, themesAdded };
  }

  /** Remove every sample entry and any theme used only by sample entries. */
  function removeSamples(journal) {
    const j = clone(journal);
    const before = j.entries.length;
    j.entries = j.entries.filter(e => !e.sample);
    const ids = new Set(j.entries.map(e => e.id));
    j.entries.forEach(e => { e.sources = e.sources.filter(s => ids.has(s)); });
    j.themes = j.themes.filter(t => !t.sample || j.entries.some(e => e.themeIds.includes(t.id)));
    return { journal: j, removed: before - j.entries.length };
  }

  function safetyCheck(text) {
    const t = str(text);
    return SAFETY_PATTERNS.some(re => re.test(t));
  }

  // ---------- storage ----------

  /**
   * Load from a Storage-like object ({getItem, setItem, removeItem}). Never throws.
   * Returns { journal, persistent, notices, corruptKey }.
   */
  function load(storage, now) {
    const notices = [];
    if (!storage) return { journal: emptyJournal(), persistent: false, notices: ['This browser is not letting the page save. Your writing will last only while this tab is open. Use Export to keep a copy.'] };
    let raw;
    try { raw = storage.getItem(STORAGE_KEY); }
    catch (err) { return { journal: emptyJournal(), persistent: false, notices: ['This browser is not letting the page save (private mode or blocked site data). Your writing will last only while this tab is open. Use Export to keep a copy.'] }; }

    let journal = emptyJournal();
    let corruptKey = null;
    if (raw) {
      let parsed = null, bad = false;
      try { parsed = JSON.parse(raw); } catch (err) { bad = true; }
      if (!bad) {
        const n = normalize(parsed);
        if (n.tooNew) {
          // Do not overwrite data a newer version wrote; work in memory only.
          return { journal: emptyJournal(), persistent: false, notices: [n.problems[0] + ' To protect it, this page will not save over it. Open the newer page instead.'] };
        }
        journal = n.journal;
        if (n.dropped) { bad = true; }
        n.problems.forEach(p => notices.push(p));
      }
      if (bad) {
        corruptKey = CORRUPT_PREFIX + Math.floor(now);
        try { storage.setItem(corruptKey, raw); notices.push('Part of your saved journal could not be read. The original was kept aside on this device, and you can download it from Your data.'); }
        catch (err) { notices.push('Part of your saved journal could not be read, and there was no room to keep the original aside.'); corruptKey = null; }
      }
    }

    // One-time import of drafts saved by the earlier version of this page.
    const legacy = legacyEntries(k => storage.getItem(k), now);
    if (legacy.length) {
      const m = mergeJournals(journal, { entries: legacy, themes: [] });
      journal = m.journal;
      if (m.added) notices.push('Brought ' + plural(m.added, 'earlier saved draft') + ' into your journal.');
      const s = save(storage, journal);
      if (s.ok) LEGACY_KEYS.forEach(k => { try { storage.removeItem(k); } catch (err) { /* keep going */ } });
    }
    return { journal, persistent: true, notices, corruptKey };
  }

  function save(storage, journal) {
    if (!storage) return { ok: false, error: 'Saving is not available in this browser.' };
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(journal));
      return { ok: true };
    } catch (err) {
      const full = err && (err.name === 'QuotaExceededError' || err.code === 22);
      return { ok: false, error: full ? 'This device is out of room for the journal. Export a copy, then delete older entries.' : 'Could not save to this device. Your writing is still on screen; use Export to keep a copy.' };
    }
  }

  /** Remove every key this tool has ever written. */
  function wipe(storage) {
    if (!storage) return { ok: true, removed: 0 };
    const keys = [STORAGE_KEY].concat(LEGACY_KEYS);
    try {
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k && k.indexOf(CORRUPT_PREFIX) === 0) keys.push(k);
      }
    } catch (err) { /* storage without key(); remove what we know */ }
    let removed = 0;
    keys.forEach(k => { try { if (storage.getItem(k) !== null) { storage.removeItem(k); removed++; } } catch (err) { /* ignore */ } });
    return { ok: true, removed };
  }

  function corruptBackups(storage) {
    const out = [];
    if (!storage) return out;
    try {
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k && k.indexOf(CORRUPT_PREFIX) === 0) out.push(k);
      }
    } catch (err) { /* ignore */ }
    return out.sort();
  }

  return {
    SCHEMA_VERSION, STORAGE_KEY, CORRUPT_PREFIX, LEGACY_KEYS, MODES, FEELINGS, STEP_STATUSES, SUMMARY_LIMITS, DAY,
    emptyJournal, normalize, legacyEntries,
    addEntry, getEntry, updateEntry, deleteEntry, restoreEntry, setStepStatus,
    addTheme, updateTheme, deleteTheme, setEntryTheme, suggestThemes,
    filterEntries, rangeFor, entryText, dayKey, shortDate,
    summarize, reviewPrompts, addReview,
    exportJSON, exportMarkdown, parseImport, mergeJournals, removeSamples,
    safetyCheck, load, save, wipe, corruptBackups
  };
});
