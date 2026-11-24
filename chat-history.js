// Trip chat: the conversation so far, and the answer's text put back together.
//
// 2026-11-24, from Erik's screenshot: "Plan the days" got an answer, then
// "No let's add it" got "I'm not sure what you'd like to add". Every turn was
// sent to the model on its own - the stored messages were only ever shown,
// never sent - so a follow-up had nothing to follow. And the answer read as
// shards (", and" on a line by itself) because a web-search answer arrives as
// many text blocks split around each citation, and they were joined with a
// blank line between every one.

const MAX_TURNS = 8;          // the last 8 questions and answers
const MAX_ANSWER_CHARS = 2500; // an old answer is context, not a transcript
const MAX_QUESTION_CHARS = 1500;

const clip = (s, n) => {
  s = String(s || '').trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
};

/** What became of a proposal, in a line the model can read. */
function proposalNote(m) {
  const notes = [];
  if (m.proposedChange) {
    const st = m.changeState === 'applied' ? 'applied by the user'
      : m.changeState === 'discarded' ? 'discarded by the user' : 'not applied yet';
    notes.push(`[You proposed an itinerary change: "${clip(m.proposedChange.summary, 200)}" - ${st}.]`);
  }
  if (m.proposedBookings) {
    const st = m.bookingsState === 'applied' ? 'applied by the user'
      : m.bookingsState === 'discarded' ? 'discarded by the user' : 'not applied yet';
    notes.push(`[You proposed bookings: "${clip(m.proposedBookings.summary, 200)}" - ${st}.]`);
  }
  return notes.join('\n');
}

/**
 * Stored messages (oldest first, each {question, answer, ...}) and the new
 * question -> the Messages API `messages` array: user/assistant pairs for the
 * last MAX_TURNS answered turns, then the new question.
 */
function toMessages(stored, question) {
  const answered = (Array.isArray(stored) ? stored : [])
    .filter((m) => m && typeof m.question === 'string' && m.question.trim() && typeof m.answer === 'string' && m.answer.trim())
    .slice(-MAX_TURNS);
  const out = [];
  for (const m of answered) {
    out.push({ role: 'user', content: clip(m.question, MAX_QUESTION_CHARS) });
    const note = proposalNote(m);
    out.push({ role: 'assistant', content: clip(m.answer, MAX_ANSWER_CHARS) + (note ? '\n\n' + note : '') });
  }
  out.push({ role: 'user', content: String(question) });
  return out;
}

/**
 * The answer's text blocks as one piece of writing. Blocks that carry a
 * citation, or sit right after one, are parts of the same sentence and are
 * joined as they are; otherwise a new block is a new paragraph. A short
 * "I'll check ..." written before the first search, when more text follows
 * the search, is dropped: it narrates the work instead of answering.
 */
function joinText(content) {
  const blocks = Array.isArray(content) ? content : [];
  const firstSearch = blocks.findIndex((b) => b && (b.type === 'server_tool_use' || b.type === 'web_search_tool_result'));
  let parts = [];
  blocks.forEach((b, i) => {
    if (!b || b.type !== 'text' || typeof b.text !== 'string') return;
    parts.push({ text: b.text, cited: Array.isArray(b.citations) && b.citations.length > 0, i });
  });
  if (firstSearch >= 0 && parts.length > 1 && parts[0].i < firstSearch
      && parts[0].text.trim().length < 240 && parts.some((p) => p.i > firstSearch && p.text.trim())) {
    parts = parts.slice(1);
  }
  let out = '';
  parts.forEach((p, k) => {
    if (k === 0) { out = p.text; return; }
    const prev = parts[k - 1];
    const glue = p.cited || prev.cited || /^[\s,.;:!?)\]'"’”-]/.test(p.text) ? '' : '\n\n';
    out += glue + p.text;
  });
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { toMessages, joinText, proposalNote, MAX_TURNS };
