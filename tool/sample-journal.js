/*
  A synthetic sample journal, so a visitor can see what the journal, look-back and review
  do before writing anything. Every entry is invented and marked sample: true, so
  "Remove sample entries" takes out exactly these and nothing the person wrote.
  Dates are placed relative to "now" so the last-7-days view always has something in it.
*/
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SBSample = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const HOUR = 3600000, DAY = 86400000;

  function sampleJournal(now) {
    const at = (daysAgo, hour) => {
      const d = new Date(now - daysAgo * DAY);
      d.setHours(hour, 15, 0, 0);
      return d.toISOString();
    };
    const themes = [
      { id: 'sample-t-work', name: 'Work', keywords: ['manager', 'meeting', 'deadline', 'report', 'team'], createdAt: at(20, 9), sample: true },
      { id: 'sample-t-sleep', name: 'Sleep', keywords: ['sleep', 'tired', 'night', 'bed'], createdAt: at(20, 9), sample: true },
      { id: 'sample-t-family', name: 'Family', keywords: ['sister', 'mom', 'dad', 'kids'], createdAt: at(20, 9), sample: true }
    ];
    const e = (id, daysAgo, hour, mode, fields, extra) => Object.assign({
      id: 'sample-' + id, mode, createdAt: at(daysAgo, hour), updatedAt: at(daysAgo, hour),
      fields, feelings: [], themeIds: [], sources: [], sample: true
    }, extra || {});

    const entries = [
      e('1', 19, 21, 'untangle', {
        happened: 'The quarterly report deadline moved up a week.',
        thought: 'There is no way I can do this well. Everyone will see I am behind.',
        felt: 'Overwhelmed. Shoulders up by my ears.',
        friend: 'You have hit tight deadlines before. Pick the parts that matter most.',
        kinder: 'It is a hard week, not proof that I am bad at my job.',
        step: 'Ask my manager which two sections matter most.'
      }, { themeIds: ['sample-t-work'], step: { status: 'done', updatedAt: at(18, 12) } }),
      e('2', 17, 22, 'feel', { pointing: 'I need the week to have an edge to it, a point where it is done.' },
        { feelings: ['Overwhelmed', 'Tired'], themeIds: ['sample-t-work', 'sample-t-sleep'] }),
      e('3', 15, 20, 'good', {
        okay: 'Got the first draft of the report in.',
        glad: 'My sister, who sent a silly photo at exactly the right time.',
        handled: 'Said no to an extra meeting.'
      }, { themeIds: ['sample-t-work', 'sample-t-family'] }),
      e('4', 12, 23, 'free', { text: 'Could not sleep again. Kept replaying the conversation with the team. Wrote it down so I could stop holding it.' },
        { themeIds: ['sample-t-sleep'] }),
      e('5', 9, 21, 'untangle', {
        happened: 'My manager moved our check-in and did not say why.',
        thought: 'I must have done something wrong. Bad news is coming.',
        felt: 'Anxious. A tight chest, and I could not focus all afternoon.',
        friend: 'Meetings move all the time. That is not proof of anything.',
        kinder: 'I do not know why it moved. I can ask instead of guessing.',
        step: 'Send a short note asking if there is anything to prep.'
      }, { themeIds: ['sample-t-work'], step: { status: 'partly', updatedAt: at(8, 10) } }),
      e('6', 6, 22, 'feel', { pointing: 'I want to know where I stand, and I want a real night of sleep.' },
        { feelings: ['Anxious', 'Tired'] }),
      e('7', 4, 19, 'good', {
        okay: 'Went to bed before eleven for three nights.',
        handled: 'Asked for help on the report instead of stalling.'
      }, { themeIds: ['sample-t-sleep'] }),
      e('8', 3, 21, 'untangle', {
        happened: 'Missed my mom\'s call because I was working late.',
        thought: 'I am always choosing work over the people I love.',
        felt: 'Guilty and a bit sad. Heavy in the stomach.',
        kinder: 'I missed one call on a busy night. I can call back tomorrow.',
        step: 'Call mom back on Saturday morning.'
      }, { themeIds: ['sample-t-family'] }),
      e('9', 1, 22, 'feel', { pointing: 'Relief that the report is out. Anxious about what comes next.' },
        { feelings: ['Relieved', 'Anxious'], themeIds: ['sample-t-work'] })
    ];
    return { version: 1, themes, entries };
  }

  return { sampleJournal, HOUR };
});
