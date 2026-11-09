/*
  Sounding Board page logic. Uses SBJournal (journal.js) for every change to the journal
  and SBSample (sample-journal.js) for the clearly labeled sample. No network calls:
  saving uses this browser's storage, export builds a file in memory, import reads a file
  the person picks.

  All user text is written with textContent, never as HTML.
*/
(function () {
  'use strict';
  const J = window.SBJournal;
  const now = () => Date.now();

  // ---------- tiny DOM helper ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(k => {
      const v = attrs[k];
      if (v === undefined || v === null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    });
    kids.flat(Infinity).forEach(c => { if (c === null || c === undefined || c === false || c === '') return; el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function longDate(isoString) {
    return new Date(isoString).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }
  function timeOf(isoString) {
    return new Date(isoString).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  // ---------- storage and state ----------
  let storage = null;
  try { storage = window.localStorage; } catch (err) { storage = null; }

  const loaded = J.load(storage, now());
  const state = {
    journal: loaded.journal,
    persistent: loaded.persistent,
    notices: loaded.notices.slice(),
    view: 'entries',
    filters: { query: '', themeId: '', mode: '' },
    expanded: new Set(),
    editing: null,
    undo: null,
    lookback: { range: '7', themeId: '' },
    reviewDrafts: {},
    confirmWipe: false,
    lastSaved: null,
    saveError: null
  };

  function commit(journal) {
    state.journal = journal;
    if (state.persistent) {
      const r = J.save(storage, journal);
      if (r.ok) { state.lastSaved = now(); state.saveError = null; }
      else state.saveError = r.error;
    }
    renderAll();
  }

  // ---------- top-level tabs ----------
  const tabs = $$('.tab');
  function showTab(id) {
    tabs.forEach(x => x.setAttribute('aria-selected', String(x.dataset.t === id)));
    $$('.panel').forEach(p => p.classList.toggle('on', p.id === id));
  }
  tabs.forEach(t => { t.onclick = () => showTab(t.dataset.t); });

  // ---------- the writing panels ----------
  const fc = $('#feelchips');
  J.FEELINGS.forEach(f => {
    fc.appendChild(h('button', { type: 'button', class: 'chip', 'aria-pressed': 'false', text: f, onclick: e => {
      const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
      e.currentTarget.setAttribute('aria-pressed', String(on));
      e.currentTarget.classList.toggle('on', on);
    } }));
  });

  function panelFields(panel) {
    const fields = {};
    $$('[data-j]', panel).forEach(t => { fields[t.dataset.j] = t.value; });
    return fields;
  }
  function clearPanel(panel) {
    $$('[data-j]', panel).forEach(t => { t.value = ''; });
    $$('.chip[aria-pressed="true"]', panel).forEach(c => { c.setAttribute('aria-pressed', 'false'); c.classList.remove('on'); });
    const s = $('.safety', panel); if (s) s.hidden = true;
  }
  function panelMsg(panel, ...kids) {
    const m = $('[data-msg]', panel);
    m.textContent = '';
    kids.forEach(k => m.appendChild(typeof k === 'string' ? document.createTextNode(k) : k));
  }

  $$('[data-save]').forEach(b => {
    b.onclick = () => {
      const panel = b.closest('.panel');
      const mode = panel.dataset.mode;
      const feelings = mode === 'feel' ? $$('#feelchips .chip[aria-pressed="true"]').map(c => c.textContent) : [];
      const r = J.addEntry(state.journal, { mode, fields: panelFields(panel), feelings, now: now() });
      if (r.error) { panelMsg(panel, r.error); return; }
      commit(r.journal);
      clearPanel(panel);
      const where = state.persistent && !state.saveError ? 'Saved to your journal, on this device only. ' : 'Added to your journal for this visit only (this browser is not saving). ';
      panelMsg(panel, where, h('button', { type: 'button', class: 'linkish', text: 'Open it', onclick: () => openEntry(r.entry.id) }));
    };
  });
  $$('[data-clear]').forEach(b => {
    b.onclick = () => { const panel = b.closest('.panel'); clearPanel(panel); panelMsg(panel, 'Cleared. Nothing in your journal was changed.'); };
  });

  // Gentle pointer to real support when writing suggests self-harm. Never blocks or stores anything.
  function safetyNote() {
    return h('p', { class: 'safety', role: 'note' },
      h('b', { text: 'You do not have to hold this alone. ' }),
      'If you are thinking about hurting yourself, please reach a person now: call or text ',
      h('a', { href: 'tel:988', text: '988' }), ', or text HOME to 741741. Outside the US, ',
      h('a', { href: 'https://findahelpline.com', target: '_blank', rel: 'noopener', text: 'findahelpline.com' }), ' lists free lines.');
  }
  function watchSafety(container) {
    container.addEventListener('input', e => {
      if (!e.target.matches('textarea')) return;
      const host = e.target.closest('[data-safety-host]') || container;
      let note = $('.safety', host);
      const hit = J.safetyCheck(e.target.value) || $$('textarea', host).some(t => J.safetyCheck(t.value));
      if (hit && !note) { note = safetyNote(); const anchor = $('[data-safety-anchor]', host); if (anchor) anchor.before(note); else host.appendChild(note); }
      if (note) note.hidden = !hit;
    });
  }
  $$('.panel[data-mode]').forEach(watchSafety);
  watchSafety($('#journal'));

  // ---------- breathing ----------
  const steps = ['Breathe in... 4', 'Hold... 4', 'Breathe out... 4', 'Hold... 4'];
  let breatheTimer = null;
  $('#breathe').onclick = () => {
    const el = $('#breathe-step');
    clearInterval(breatheTimer);
    el.style.display = 'inline-block';
    let i = 0, n = 0;
    el.textContent = steps[0];
    breatheTimer = setInterval(() => {
      i = (i + 1) % 4; if (i === 0) n++;
      el.textContent = steps[i];
      if (n >= 2 && i === 3) { clearInterval(breatheTimer); setTimeout(() => { el.textContent = 'Nicely done.'; }, 4000); }
    }, 4000);
  };

  // ---------- journal: shared pieces ----------
  const jroot = $('#journal');
  const views = { entries: renderEntries, lookback: renderLookback, review: renderReview, themes: renderThemes, data: renderData };

  $$('[data-view]', jroot).forEach(b => {
    b.onclick = () => { state.view = b.dataset.view; renderJournal(); };
  });

  function themeName(id) { const t = state.journal.themes.find(x => x.id === id); return t ? t.name : ''; }
  function entryTitle(e) {
    const f = e.fields;
    const first = f.happened || f.text || f.okay || f.glad || f.handled || f.pointing || f.thought || '';
    if (e.mode === 'feel' && e.feelings.length) return e.feelings.join(', ') + (first ? ': ' + first : '');
    return first;
  }

  function sourceLinks(ids, label) {
    const items = ids.map(id => J.getEntry(state.journal, id)).filter(Boolean);
    if (!items.length) return null;
    return h('p', { class: 'sources' }, (label || 'From') + ': ',
      items.map((e, i) => [i ? ', ' : '', h('button', { type: 'button', class: 'linkish', 'data-source': e.id, title: J.MODES[e.mode].label + ', ' + longDate(e.createdAt), text: J.shortDate(e.createdAt) + ' (' + J.MODES[e.mode].label.toLowerCase() + ')', onclick: () => openEntry(e.id) })]));
  }

  function openEntry(id) {
    if (!J.getEntry(state.journal, id)) return;
    showTab('journal');
    state.view = 'entries';
    const visible = J.filterEntries(state.journal, state.filters).some(e => e.id === id);
    if (!visible) state.filters = { query: '', themeId: '', mode: '' };
    state.expanded.add(id);
    renderJournal();
    const el = document.getElementById('entry-' + id);
    if (el) { el.scrollIntoView({ block: 'start', behavior: 'smooth' }); const btn = $('.entry-head', el); if (btn) btn.focus({ preventScroll: true }); }
  }

  function download(name, text, type) {
    const blob = new Blob([text], { type: type || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function stamp() { return J.dayKey(new Date(now()).toISOString()); }

  function themeOptions(selected, { any, none } = {}) {
    const opts = [h('option', { value: '', text: any || 'All themes' })];
    if (none) opts.push(h('option', { value: '__none', text: 'No theme yet', selected: selected === '__none' }));
    state.journal.themes.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach(t => opts.push(h('option', { value: t.id, text: t.name, selected: selected === t.id })));
    return opts;
  }

  // ---------- journal: entries ----------
  function renderEntries(box) {
    // Quick note
    const note = h('textarea', { id: 'j-note', 'aria-label': 'Write a note', placeholder: 'Anything on your mind. It goes straight into your journal.' });
    const noteMsg = h('p', { class: 'q', 'aria-live': 'polite' });
    box.appendChild(h('div', { class: 'jcard', 'data-safety-host': true },
      h('label', { for: 'j-note', text: 'Write a note' }), note,
      h('div', { class: 'savebar', 'data-safety-anchor': true }, h('button', { type: 'button', class: 'btn', id: 'j-note-save', text: 'Save note', onclick: () => {
        const r = J.addEntry(state.journal, { mode: 'free', fields: { text: note.value }, now: now() });
        if (r.error) { noteMsg.textContent = r.error; return; }
        state.expanded.add(r.entry.id);
        commit(r.journal);
      } })), noteMsg));

    // Filters
    const q = h('input', { type: 'search', id: 'j-search', value: state.filters.query, placeholder: 'Words you wrote', oninput: e => { state.filters.query = e.target.value; renderList(); } });
    const th = h('select', { id: 'j-theme', onchange: e => { state.filters.themeId = e.target.value; renderList(); } }, themeOptions(state.filters.themeId, { none: true }));
    const kinds = [['', 'All kinds']].concat(Object.keys(J.MODES).map(k => [k, J.MODES[k].label]));
    const md = h('select', { id: 'j-mode', onchange: e => { state.filters.mode = e.target.value; renderList(); } }, kinds.map(([v, t]) => h('option', { value: v, text: t, selected: state.filters.mode === v })));
    box.appendChild(h('div', { class: 'filters' },
      h('div', null, h('label', { for: 'j-search', text: 'Search' }), q),
      h('div', null, h('label', { for: 'j-theme', text: 'Theme' }), th),
      h('div', null, h('label', { for: 'j-mode', text: 'Kind' }), md)));

    if (state.undo) {
      box.appendChild(h('p', { class: 'undo', role: 'status' }, 'Entry deleted. ',
        h('button', { type: 'button', class: 'linkish', id: 'j-undo', text: 'Undo', onclick: () => {
          const r = J.restoreEntry(state.journal, state.undo); state.undo = null; commit(r.journal);
        } })));
    }

    const list = h('div', { id: 'j-list', 'aria-live': 'polite' });
    box.appendChild(list);
    function renderList() {
      list.textContent = '';
      const rows = J.filterEntries(state.journal, state.filters);
      const total = state.journal.entries.length;
      list.appendChild(h('p', { class: 'q', id: 'j-count', text: total === 0 ? 'Your journal is empty. Save something from any tab above, write a note, or load the sample journal from Your data.' : 'Showing ' + rows.length + ' of ' + total + (total === 1 ? ' entry.' : ' entries.') }));
      rows.forEach(e => list.appendChild(entryCard(e)));
    }
    renderList();
  }

  function entryCard(e) {
    const open = state.expanded.has(e.id);
    const card = h('article', { class: 'entry' + (open ? ' open' : ''), id: 'entry-' + e.id, 'data-entry': e.id });
    const tags = e.themeIds.map(themeName).filter(Boolean);
    card.appendChild(h('button', { type: 'button', class: 'entry-head', 'aria-expanded': String(open), onclick: () => {
      if (state.expanded.has(e.id)) state.expanded.delete(e.id); else state.expanded.add(e.id);
      if (state.editing === e.id) state.editing = null;
      renderJournal();
    } },
      h('span', { class: 'entry-meta' }, h('span', { class: 'tag', text: J.MODES[e.mode].label }), ' ', longDate(e.createdAt) + ', ' + timeOf(e.createdAt), e.sample ? h('span', { class: 'sample', text: 'Sample' }) : null),
      h('span', { class: 'entry-title', text: entryTitle(e) || '(no text)' }),
      tags.length ? h('span', { class: 'entry-tags', text: tags.join(' · ') }) : null));
    if (!open) return card;

    const body = h('div', { class: 'entry-body', 'data-safety-host': true });
    card.appendChild(body);
    if (state.editing === e.id) { body.appendChild(editForm(e)); return card; }

    if (e.feelings.length) body.appendChild(h('div', { class: 'chips' }, e.feelings.map(f => h('span', { class: 'chip on', text: f }))));
    const dl = h('dl');
    J.MODES[e.mode].fields.forEach(f => {
      if (!e.fields[f.key]) return;
      dl.appendChild(h('dt', { text: f.label }));
      dl.appendChild(h('dd', { text: e.fields[f.key] }));
    });
    body.appendChild(dl);
    const back = sourceLinks(e.sources, 'Looks back at'); if (back) body.appendChild(back);

    if (e.step) {
      body.appendChild(h('div', { class: 'stepbar', role: 'group', 'aria-label': 'How did the next step go?' },
        h('span', { class: 'q', text: 'How did the next step go? ' }),
        Object.keys(J.STEP_STATUSES).map(k => h('button', { type: 'button', class: 'chip' + (e.step.status === k ? ' on' : ''), 'aria-pressed': String(e.step.status === k), 'data-step': k, text: J.STEP_STATUSES[k], onclick: () => {
          commit(J.setStepStatus(state.journal, e.id, k, now()).journal);
        } }))));
    }

    // Themes: the person's own tags, plus keyword suggestions that say why.
    if (state.journal.themes.length) {
      body.appendChild(h('div', { class: 'themebar', role: 'group', 'aria-label': 'Themes for this entry' },
        h('span', { class: 'q', text: 'Themes: ' }),
        state.journal.themes.map(t => {
          const on = e.themeIds.includes(t.id);
          return h('button', { type: 'button', class: 'chip' + (on ? ' on' : ''), 'aria-pressed': String(on), 'data-theme-toggle': t.id, text: t.name, onclick: () => {
            commit(J.setEntryTheme(state.journal, e.id, t.id, !on).journal);
          } });
        })));
      J.suggestThemes(state.journal, e).forEach(s => {
        body.appendChild(h('p', { class: 'suggest' }, 'Maybe ' + s.name + '? You gave that theme the word' + (s.matched.length > 1 ? 's ' : ' ') + s.matched.map(w => '"' + w + '"').join(', ') + ', and it appears here. ',
          h('button', { type: 'button', class: 'linkish', 'data-suggest': s.themeId, text: 'Add ' + s.name, onclick: () => commit(J.setEntryTheme(state.journal, e.id, s.themeId, true).journal) })));
      });
    } else {
      body.appendChild(h('p', { class: 'q' }, 'No themes yet. ', h('button', { type: 'button', class: 'linkish', text: 'Make one', onclick: () => { state.view = 'themes'; renderJournal(); } }), ' to group entries your way.'));
    }

    body.appendChild(h('div', { class: 'savebar' },
      h('button', { type: 'button', class: 'btn ghost', 'data-edit': e.id, text: 'Edit', onclick: () => { state.editing = e.id; renderJournal(); } }),
      h('button', { type: 'button', class: 'btn ghost', text: 'Export this entry', onclick: () => download('sounding-board-entry-' + J.dayKey(e.createdAt) + '.md', J.exportMarkdown(state.journal, now(), { entryIds: [e.id] }), 'text/markdown') }),
      h('button', { type: 'button', class: 'btn ghost danger', 'data-delete': e.id, text: 'Delete', onclick: () => {
        const r = J.deleteEntry(state.journal, e.id);
        state.undo = r.removed; state.expanded.delete(e.id);
        commit(r.journal);
        const u = $('#j-undo'); if (u) u.focus();
      } })));
    if (e.updatedAt !== e.createdAt) body.appendChild(h('p', { class: 'q', text: 'Edited ' + longDate(e.updatedAt) + ', ' + timeOf(e.updatedAt) + '.' }));
    return card;
  }

  function editForm(e) {
    const form = h('div', { class: 'editform' });
    const inputs = {};
    let chips = null;
    if (e.mode === 'feel') {
      const picked = new Set(e.feelings);
      chips = h('div', { class: 'chips' }, J.FEELINGS.concat(e.feelings.filter(f => !J.FEELINGS.includes(f))).map(f => h('button', {
        type: 'button', class: 'chip' + (picked.has(f) ? ' on' : ''), 'aria-pressed': String(picked.has(f)), text: f, onclick: ev => {
          const on = ev.currentTarget.getAttribute('aria-pressed') !== 'true';
          ev.currentTarget.setAttribute('aria-pressed', String(on)); ev.currentTarget.classList.toggle('on', on);
        } })));
      form.appendChild(chips);
    }
    J.MODES[e.mode].fields.forEach(f => {
      const id = 'edit-' + e.id + '-' + f.key;
      inputs[f.key] = h('textarea', { id, 'data-field': f.key });
      inputs[f.key].value = e.fields[f.key] || '';
      form.appendChild(h('label', { for: id, text: f.label }));
      form.appendChild(inputs[f.key]);
    });
    const msg = h('p', { class: 'q', 'aria-live': 'polite' });
    form.appendChild(h('div', { class: 'savebar', 'data-safety-anchor': true },
      h('button', { type: 'button', class: 'btn', 'data-save-edit': e.id, text: 'Save changes', onclick: () => {
        const fields = {}; Object.keys(inputs).forEach(k => { fields[k] = inputs[k].value; });
        const patch = { fields };
        if (chips) patch.feelings = $$('.chip[aria-pressed="true"]', chips).map(c => c.textContent);
        const r = J.updateEntry(state.journal, e.id, patch, now());
        if (r.error) { msg.textContent = r.error; return; }
        state.editing = null; commit(r.journal);
      } }),
      h('button', { type: 'button', class: 'btn ghost', text: 'Cancel', onclick: () => { state.editing = null; renderJournal(); } })));
    form.appendChild(msg);
    return form;
  }

  // ---------- journal: look back ----------
  function lookbackRange() {
    return J.rangeFor(state.lookback.range, now());
  }
  function renderLookback(box) {
    const rangeSel = h('select', { id: 'lb-range', onchange: ev => { state.lookback.range = ev.target.value; renderJournal(); } },
      [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['all', 'All time']].map(([v, t]) => h('option', { value: v, text: t, selected: state.lookback.range === v })));
    const themeSel = h('select', { id: 'lb-theme', onchange: ev => { state.lookback.themeId = ev.target.value; renderJournal(); } }, themeOptions(state.lookback.themeId));
    box.appendChild(h('div', { class: 'filters' },
      h('div', null, h('label', { for: 'lb-range', text: 'Look back over' }), rangeSel),
      h('div', null, h('label', { for: 'lb-theme', text: 'Theme' }), themeSel)));

    const r = lookbackRange();
    const s = J.summarize(state.journal, { from: r.from, to: r.to, themeId: state.lookback.themeId || null, label: r.label });
    const out = h('div', { class: 'jcard', id: 'lb-out' });
    out.appendChild(h('h3', { text: s.headline }));
    s.sections.forEach(sec => {
      out.appendChild(h('h4', { text: sec.title }));
      if (sec.lead) out.appendChild(h('p', { text: sec.lead }));
      const ul = h('ul', { class: 'lb-items' });
      sec.items.forEach(it => {
        const li = h('li', { 'data-section': sec.id });
        if (it.quote !== undefined || it.reframe) {
          li.appendChild(h('span', { class: 'q', text: it.text }));
          if (it.quote) li.appendChild(h('blockquote', { text: it.quote }));
          if (it.reframe) li.appendChild(h('blockquote', { class: 'reframe', text: it.reframe }));
        } else li.appendChild(h('span', { text: it.text }));
        const src = sourceLinks(it.sources); if (src) li.appendChild(src);
        ul.appendChild(li);
      });
      out.appendChild(ul);
    });
    out.appendChild(h('p', { class: 'note', id: 'lb-limits' }, h('b', { text: 'What this is. ' }), s.limits));
    if (s.entryCount) {
      out.appendChild(h('div', { class: 'savebar' },
        h('button', { type: 'button', class: 'btn', text: 'Answer review questions', onclick: () => { state.view = 'review'; renderJournal(); } }),
        h('button', { type: 'button', class: 'btn ghost', id: 'lb-export', text: 'Export this look-back', onclick: () => download('sounding-board-lookback-' + stamp() + '.md', lookbackMarkdown(s), 'text/markdown') })));
    }
    box.appendChild(out);
  }
  function lookbackMarkdown(s) {
    const ref = ids => ids.map(id => J.getEntry(state.journal, id)).filter(Boolean).map(e => J.dayKey(e.createdAt)).join(', ');
    const lines = ['# Look-back: ' + s.label + (s.themeName ? ', ' + s.themeName : ''), '', s.headline, ''];
    s.sections.forEach(sec => {
      lines.push('## ' + sec.title);
      if (sec.lead) lines.push(sec.lead);
      sec.items.forEach(it => {
        lines.push('- ' + it.text + (it.quote ? ' "' + it.quote + '"' : '') + (it.reframe ? ' Kinder version: "' + it.reframe + '"' : '') + ' (from ' + ref(it.sources) + ')');
      });
      lines.push('');
    });
    lines.push('_' + s.limits + '_', '');
    return lines.join('\n');
  }

  // ---------- journal: review ----------
  function renderReview(box) {
    const prompts = J.reviewPrompts(state.journal, now());
    box.appendChild(h('p', { class: 'q', text: 'A few questions picked from what you wrote in the last two weeks. Each one says why it was picked. Answer any, skip any; nothing here is a test or a streak.' }));
    const form = h('div', { class: 'jcard', 'data-safety-host': true });
    prompts.forEach((p, i) => {
      const id = 'rv-' + i;
      const ta = h('textarea', { id, 'data-prompt': p.id, oninput: ev => { state.reviewDrafts[p.id] = ev.target.value; } });
      ta.value = state.reviewDrafts[p.id] || '';
      const block = h('div', { class: 'prompt', 'data-kind': p.kind },
        h('label', { for: id, text: p.text }),
        h('p', { class: 'why' }, h('b', { text: 'Why this question: ' }), p.why),
        sourceLinks(p.sources));
      if (p.stepEntryId) {
        const e = J.getEntry(state.journal, p.stepEntryId);
        block.appendChild(h('div', { class: 'stepbar', role: 'group', 'aria-label': 'Mark the step' },
          Object.keys(J.STEP_STATUSES).filter(k => k !== 'open').map(k => h('button', { type: 'button', class: 'chip' + (e.step.status === k ? ' on' : ''), 'data-step': k, text: J.STEP_STATUSES[k], onclick: () => {
            commit(J.setStepStatus(state.journal, e.id, k, now()).journal);
          } }))));
      }
      block.appendChild(ta);
      form.appendChild(block);
    });
    const msg = h('p', { class: 'q', id: 'rv-msg', 'aria-live': 'polite' });
    form.appendChild(h('div', { class: 'savebar', 'data-safety-anchor': true }, h('button', { type: 'button', class: 'btn', id: 'rv-save', text: 'Save review to my journal', onclick: () => {
      const answers = prompts.map(p => ({ prompt: p.text, answer: state.reviewDrafts[p.id] || '', sources: p.sources }));
      const r = J.addReview(state.journal, { answers, now: now() });
      if (r.error) { msg.textContent = r.error; return; }
      state.reviewDrafts = {};
      commit(r.journal);
      const m = $('#rv-msg'); if (m) { m.textContent = 'Review saved. '; m.appendChild(h('button', { type: 'button', class: 'linkish', text: 'Open it', onclick: () => openEntry(r.entry.id) })); }
    } })));
    form.appendChild(msg);
    box.appendChild(form);
  }

  // ---------- journal: themes ----------
  function renderThemes(box) {
    box.appendChild(h('p', { class: 'q', text: 'Themes are your own labels for grouping entries. Add keywords if you want suggestions: when an entry contains one of your words, the entry offers that theme and says which word matched. Nothing is tagged unless you tap it.' }));
    const name = h('input', { id: 'th-name', placeholder: 'For example: Work, Sleep, Family' });
    const kw = h('input', { id: 'th-kw', placeholder: 'Optional, comma separated: manager, deadline' });
    const msg = h('p', { class: 'q', id: 'th-msg', 'aria-live': 'polite' });
    box.appendChild(h('div', { class: 'jcard' },
      h('label', { for: 'th-name', text: 'New theme' }), name,
      h('label', { for: 'th-kw', text: 'Keywords for suggestions' }), kw,
      h('div', { class: 'savebar' }, h('button', { type: 'button', class: 'btn', id: 'th-add', text: 'Add theme', onclick: () => {
        const r = J.addTheme(state.journal, { name: name.value, keywords: kw.value, now: now() });
        if (r.error) { msg.textContent = r.error; return; }
        commit(r.journal);
        const m = $('#th-msg'); if (m) m.textContent = 'Added ' + r.theme.name + '.';
      } })), msg));

    state.journal.themes.forEach(t => {
      const count = state.journal.entries.filter(e => e.themeIds.includes(t.id)).length;
      const n = h('input', { value: t.name, 'aria-label': 'Theme name', 'data-theme-name': t.id });
      const k = h('input', { value: t.keywords.join(', '), 'aria-label': 'Keywords for ' + t.name });
      const m = h('p', { class: 'q', 'aria-live': 'polite' });
      const confirmBox = h('span');
      box.appendChild(h('div', { class: 'jcard theme', 'data-theme': t.id },
        h('h4', null, t.name, ' ', h('span', { class: 'q', text: count + (count === 1 ? ' entry' : ' entries') })),
        h('label', { text: 'Name' }), n, h('label', { text: 'Keywords' }), k,
        h('div', { class: 'savebar' },
          h('button', { type: 'button', class: 'btn ghost', text: 'Save changes', onclick: () => {
            const r = J.updateTheme(state.journal, t.id, { name: n.value, keywords: k.value });
            if (r.error) { m.textContent = r.error; return; }
            commit(r.journal);
          } }),
          h('button', { type: 'button', class: 'btn ghost', text: 'Show entries', onclick: () => { state.filters = { query: '', themeId: t.id, mode: '' }; state.view = 'entries'; renderJournal(); } }),
          h('button', { type: 'button', class: 'btn ghost danger', 'data-theme-delete': t.id, text: 'Delete theme', onclick: () => {
            confirmBox.textContent = '';
            confirmBox.appendChild(h('span', { class: 'q', text: 'Entries stay; they just lose this label. ' }));
            confirmBox.appendChild(h('button', { type: 'button', class: 'btn danger', 'data-theme-delete-yes': t.id, text: 'Yes, delete ' + t.name, onclick: () => commit(J.deleteTheme(state.journal, t.id).journal) }));
          } }), confirmBox), m));
    });
  }

  // ---------- journal: your data ----------
  function renderData(box) {
    const j = state.journal;
    const status = state.persistent
      ? (state.saveError ? state.saveError : 'Your journal is saved in this browser on this device. It is never sent anywhere. Clearing this browser’s site data also removes it, so export a copy now and then.')
      : 'This browser is not saving. Your journal lasts only while this tab is open. Export to keep a copy.';
    box.appendChild(h('div', { class: 'jcard' },
      h('h4', { text: 'Where your journal lives' }),
      h('p', { id: 'data-status', text: status }),
      h('p', { class: 'q', id: 'data-counts', text: j.entries.length + (j.entries.length === 1 ? ' entry' : ' entries') + ', ' + j.themes.length + (j.themes.length === 1 ? ' theme' : ' themes') + (state.lastSaved ? '. Last saved ' + new Date(state.lastSaved).toLocaleTimeString() + '.' : '.') })));

    const filtered = J.filterEntries(j, state.filters);
    const filteredNote = (state.filters.query || state.filters.themeId || state.filters.mode) ? ' (' + filtered.length + ' entries match your current filter)' : '';
    box.appendChild(h('div', { class: 'jcard' },
      h('h4', { text: 'Export' }),
      h('p', { class: 'q', text: 'A backup file (JSON) can be imported here again, on this or another device. A text file (Markdown) is easy to read, print or paste anywhere.' }),
      h('div', { class: 'savebar' },
        h('button', { type: 'button', class: 'btn', id: 'ex-json', text: 'Download backup (JSON)', onclick: () => download('sounding-board-backup-' + stamp() + '.json', J.exportJSON(j, now()), 'application/json') }),
        h('button', { type: 'button', class: 'btn ghost', id: 'ex-md', text: 'Download as text', onclick: () => download('sounding-board-journal-' + stamp() + '.md', J.exportMarkdown(j, now()), 'text/markdown') }),
        filteredNote ? h('button', { type: 'button', class: 'btn ghost', id: 'ex-filtered', text: 'Download only filtered entries' + filteredNote, onclick: () => download('sounding-board-selection-' + stamp() + '.md', J.exportMarkdown(j, now(), { entryIds: filtered.map(e => e.id) }), 'text/markdown') }) : null)));

    const file = h('input', { type: 'file', id: 'im-file', accept: 'application/json,.json' });
    const msg = h('p', { class: 'q', id: 'im-msg', 'aria-live': 'polite' });
    file.onchange = () => {
      const f = file.files && file.files[0];
      if (!f) return;
      if (f.size > 20 * 1024 * 1024) { msg.textContent = 'That file is too large to be a Sounding Board backup.'; return; }
      const reader = new FileReader();
      reader.onerror = () => { msg.textContent = 'Could not read that file.'; };
      reader.onload = () => {
        const p = J.parseImport(String(reader.result));
        if (!p.ok) { msg.textContent = p.error; return; }
        const m = J.mergeJournals(state.journal, p.journal);
        commit(m.journal);
        const out = $('#im-msg');
        if (out) out.textContent = 'Imported ' + m.added + (m.added === 1 ? ' entry' : ' entries') + (m.skipped ? ', skipped ' + m.skipped + ' already here' : '') + (m.themesAdded ? ', added ' + m.themesAdded + ' theme' + (m.themesAdded === 1 ? '' : 's') : '') + '.' + (p.problems.length ? ' ' + p.problems.join(' ') : '');
      };
      reader.readAsText(f);
    };
    box.appendChild(h('div', { class: 'jcard' },
      h('h4', { text: 'Import a backup' }),
      h('p', { class: 'q', text: 'Adds entries from a backup file. Entries you already have are left as they are.' }),
      h('label', { for: 'im-file', text: 'Choose a backup file' }), file, msg));

    const hasSample = j.entries.some(e => e.sample);
    box.appendChild(h('div', { class: 'jcard' },
      h('h4', { text: 'Sample journal' }),
      h('p', { class: 'q', text: 'Nine invented entries from a made-up person, so you can see how themes, the look-back and review work. They are marked Sample and can be removed in one tap without touching your own writing.' }),
      h('div', { class: 'savebar' },
        hasSample
          ? h('button', { type: 'button', class: 'btn ghost', id: 'sample-remove', text: 'Remove sample entries', onclick: () => commit(J.removeSamples(state.journal).journal) })
          : h('button', { type: 'button', class: 'btn ghost', id: 'sample-load', text: 'Load the sample journal', onclick: () => {
            const m = J.mergeJournals(state.journal, J.normalize(window.SBSample.sampleJournal(now())).journal);
            state.lookback = { range: '30', themeId: '' };
            commit(m.journal);
          } }))));

    const backups = J.corruptBackups(storage);
    if (backups.length) {
      box.appendChild(h('div', { class: 'jcard' },
        h('h4', { text: 'Unreadable saved data' }),
        h('p', { class: 'q', text: 'Some saved data could not be read, so it was kept aside instead of being thrown away. Download it if you want to try to recover anything by hand.' }),
        backups.map(k => h('button', { type: 'button', class: 'btn ghost', text: 'Download ' + k, onclick: () => { let raw = ''; try { raw = storage.getItem(k) || ''; } catch (err) { /* ignore */ } download(k + '.txt', raw); } }))));
    }

    const wipeBox = h('div', { class: 'savebar' });
    if (!state.confirmWipe) {
      wipeBox.appendChild(h('button', { type: 'button', class: 'btn ghost danger', id: 'wipe', text: 'Delete everything', onclick: () => { state.confirmWipe = true; renderJournal(); $('#wipe-yes').focus(); } }));
    } else {
      wipeBox.appendChild(h('p', { class: 'q', text: 'This removes every entry, theme and review from this device. It cannot be undone. Download a backup first if you might want it later.' }));
      wipeBox.appendChild(h('button', { type: 'button', class: 'btn danger', id: 'wipe-yes', text: 'Yes, delete everything', onclick: () => {
        J.wipe(storage);
        state.confirmWipe = false; state.undo = null; state.expanded.clear(); state.reviewDrafts = {};
        state.journal = J.emptyJournal();
        state.notices = ['Everything was deleted from this device.'];
        renderAll();
      } }));
      wipeBox.appendChild(h('button', { type: 'button', class: 'btn ghost', text: 'Keep my journal', onclick: () => { state.confirmWipe = false; renderJournal(); } }));
    }
    box.appendChild(h('div', { class: 'jcard' }, h('h4', { text: 'Delete' }), h('p', { class: 'q', text: 'Delete single entries from the entry itself. This removes all of it.' }), wipeBox));
  }

  // ---------- render ----------
  // Re-rendering replaces the journal's DOM, so remember which control had focus and put
  // focus back on its replacement. Keyboard and screen reader users keep their place.
  const FOCUS_ATTRS = ['data-step', 'data-theme-toggle', 'data-suggest', 'data-edit', 'data-delete', 'data-save-edit', 'data-view', 'data-theme-delete', 'data-source'];
  function focusKey() {
    const el = document.activeElement;
    if (!el || !jroot.contains(el)) return null;
    if (el.id) return '#' + CSS.escape(el.id);
    const card = el.closest('[data-entry]');
    const scope = card ? '#entry-' + CSS.escape(card.dataset.entry) + ' ' : '';
    if (el.classList.contains('entry-head')) return scope + '.entry-head';
    const attr = FOCUS_ATTRS.find(a => el.hasAttribute(a));
    return attr ? scope + '[' + attr + '="' + CSS.escape(el.getAttribute(attr)) + '"]' : null;
  }
  function restoreFocus(key) {
    if (!key) return;
    const el = $(key);
    if (el && document.activeElement !== el) el.focus({ preventScroll: true });
  }

  function renderJournal() {
    const key = focusKey();
    renderJournalInner();
    restoreFocus(key);
  }
  function renderJournalInner() {
    $$('[data-view]', jroot).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
    const notices = $('#j-notices');
    notices.textContent = '';
    state.notices.forEach(n => notices.appendChild(h('p', { class: 'notice', text: n })));
    if (state.notices.length) notices.appendChild(h('button', { type: 'button', class: 'linkish', text: 'Dismiss', onclick: () => { state.notices = []; renderJournal(); } }));
    const box = $('#j-view');
    box.textContent = '';
    views[state.view](box);
  }
  function renderAll() {
    const c = $('#jcount');
    c.textContent = state.journal.entries.length ? String(state.journal.entries.length) : '';
    renderJournal();
  }

  // Another tab of this page saved. Take its journal so this tab never saves a stale copy
  // over it (which would silently lose whatever the other tab wrote).
  window.addEventListener('storage', ev => {
    if (!state.persistent || ev.storageArea !== storage) return;
    if (ev.key === null) { state.journal = J.emptyJournal(); state.expanded.clear(); state.editing = null; state.undo = null; renderAll(); return; }
    if (ev.key !== J.STORAGE_KEY) return;
    let parsed = null;
    try { parsed = ev.newValue ? JSON.parse(ev.newValue) : J.emptyJournal(); } catch (err) { return; }
    const n = J.normalize(parsed);
    if (n.tooNew) { state.persistent = false; state.notices = [n.problems[0] + ' Another tab saved it, so this tab stopped saving to protect it.']; renderAll(); return; }
    state.journal = n.journal;
    state.undo = null;
    // Do not rebuild the screen under someone mid-edit; their typing would be lost. Saving the
    // edit applies it to the fresh journal by id and re-renders then.
    if (state.editing) { $('#jcount').textContent = state.journal.entries.length ? String(state.journal.entries.length) : ''; return; }
    renderAll();
  });

  renderAll();
  if (state.notices.length || location.hash === '#journal') showTab('journal');

  // For tests and for anyone curious: read-only view of the current journal.
  window.SoundingBoard = { get journal() { return JSON.parse(JSON.stringify(state.journal)); }, openEntry };
})();
