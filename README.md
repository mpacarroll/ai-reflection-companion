# Reflection Companion: "Sounding Board"

A free, private space to think something through: guided prompts to untangle a hard moment, name what you feel, and steady yourself, plus grounding exercises.

**Live:** mpacarroll.github.io/ai-reflection-companion/tool/ · **Tool:** `tool/index.html` (self-contained, no account; anything you write stays on your device and can be cleared).

## Private journal

Anything saved from the guided tabs lands in **My journal**, on the device only:

- **Entries**: edit, delete (with undo), search, filter by theme or kind, mark how a next step went (did it, partly, let it go; no streaks).
- **Themes**: the person's own labels. Optional keywords produce suggestions that say which word matched; nothing is tagged automatically.
- **Look back**: a summary of the last 7 days, 30 days or all time, optionally for one theme. It only repeats, counts and links to what was written; every item links to its source entry.
- **Review**: a few questions picked from recent entries, each with "why this question" and links to its sources. Answers save as a review entry linked back to them.
- **Your data**: download a JSON backup or a readable text (Markdown) file, import a backup (merges, no duplicates), load or remove a clearly labeled synthetic sample journal, and delete everything.

Storage problems never destroy writing: unreadable saved data is kept aside and offered for download, blocked storage falls back to this tab only with a visible warning, and drafts from the earlier version of the page are migrated once.

Code: `tool/journal.js` (data model and logic, no DOM), `tool/app.js` (page), `tool/sample-journal.js` (synthetic sample). No build step, no dependencies, no network calls.

## Tests

Requires Node 18+ and, for the browser tests, Playwright with Chromium available to `require('playwright')`.

```
npm test          # journal logic (node:test)
npm run test:e2e  # the page in headless Chromium, desktop and phone
```

Set `SB_SHOTS=/some/dir` to save screenshots from the browser tests.

## Important
This is a **self-guided journaling/reflection tool. It is NOT therapy**, not a therapist, and not a substitute for professional mental-health care. A persistent crisis banner (988 Suicide & Crisis Lifeline, Crisis Text Line, findahelpline.com, 911) is shown at all times. If things feel heavy or persistent, reaching a real person is the strong move.

Part of Mick Cairn's free tools: *the professionals you can't afford, made free and plain.* Provides reflection/coping supports only; no medical or mental-health advice. Not affiliated with any employer.

## License
MIT, see [LICENSE](LICENSE).
