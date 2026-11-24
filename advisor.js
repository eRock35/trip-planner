// The advisor tool on the trip assistant (2026-11-24, off unless TRIP_ADVISOR
// is set). The chat's own model - the "executor", whatever planFor picked -
// stays what it is; on a planning ask it may consult a stronger model before
// it commits to a plan. CLAUDE.md "The advisor on trip chat" has the why, the
// cost and the switch.
//
// Every string here is from the Claude API docs (the advisor tool page, and
// the claude-api skill's shared/tool-use-concepts.md "Server-Side Tools:
// Advisor (Beta)"). Do not guess a new one: a wrong type or beta is a 400.
//   tool type   advisor_20260301, name "advisor"
//   beta        advisor-tool-2026-03-01 (the anthropic-beta header)
//   max_uses    "Maximum number of advisor calls allowed in a single turn"
//               - a turn can span several requests (pause_turn), so this is
//               the whole chat turn's cap, enforced by the API
//   max_tokens  "Caps the advisor's total output (thinking plus text) per
//               call. Minimum 1024."
const TOOL_TYPE = 'advisor_20260301';
const BETA = 'advisor-tool-2026-03-01';
// Opus 5.5 is a valid advisor for both executors this app runs
// (claude-haiku-4-5 and claude-sonnet-5) in the docs' pairing table. A pair
// the API does not accept is a 400, which completeAdvised answers without it.
const MODEL = 'claude-opus-5-5';
const MAX_USES = 2;
const MAX_TOKENS = 2048;

const TOOL = Object.freeze({
  type: TOOL_TYPE,
  name: 'advisor',
  model: MODEL,
  max_uses: MAX_USES,
  max_tokens: MAX_TOKENS,
});

// The API makes the advisor something the executor CHOOSES to call, so the
// prompt is what keeps a plain question from paying for one. Appended to the
// end of the system prompt, and only when the tool is in the request.
const PROMPT =
  '\n\nYou have an `advisor` tool backed by a stronger planning model. It takes no parameters: calling it ' +
  'forwards this whole conversation, search results included. Consult the advisor once before you commit to a ' +
  'multi-day plan, a rebalanced schedule or a trade-off between options - after any searching you need, and ' +
  'before you call propose_schedule_change. Weigh its advice against what the user asked for and what your ' +
  'searches found; where they conflict, what the user asked for and what you verified win. Do not call it for ' +
  'a simple question, a single fact or a bookings update, and never mention the advisor in your answer.';

/** 'off' | 'all' | 'paid'. Read on every request, so the switch is an env var
 *  and nothing else. Anything but "1" or "paid" is off. */
function mode() {
  const v = String(process.env.TRIP_ADVISOR || '').trim().toLowerCase();
  if (v === '1') return 'all';
  if (v === 'paid') return 'paid';
  return 'off';
}

// A coarse gate in code, in front of the model's own judgment: the tool is
// only offered when the question reads like planning work - drafting or
// reshaping the itinerary, or choosing between options. "What's the weather
// in Lisbon?" never carries the tool at all, so it cannot trigger a call.
const PLANNING = new RegExp('\\b(' + [
  'itinerar\\w*', 'day[- ]by[- ]day', 'schedul\\w*',
  're-?balanc\\w*', 're-?arrang\\w*', 're-?organi[sz]\\w*', 're-?order\\w*', 're-?plan\\w*', 're-?work\\w*',
  'plan (out|my|our|the|a|an|each|every|\\d+)', 'draft\\w*',
  'too (packed|busy|rushed|full|much)', 'less rushed', 'spread (it |them |things )?out',
  'trade-?offs?', 'pros and cons', 'versus', 'vs', 'compar\\w+', 'choose', 'decide',
  'which (one|is better|would you|should)', 'should (we|i)\\b.*\\bor', '(better|best) (option|choice)',
].join('|') + ')\\b', 'i');

function isPlanningAsk(question) {
  return typeof question === 'string' && PLANNING.test(question);
}

/** Should this turn carry the advisor? `plan` is identity's planFor result. */
function wanted(question, plan) {
  const m = mode();
  if (m === 'off') return false;
  if (m === 'paid' && !(plan && plan.tier === 'paid')) return false;
  return isPlanningAsk(question);
}

/** The same request with the advisor added: a new object, the original
 *  untouched (it is what the fallback sends). */
function withAdvisor(params) {
  return Object.assign({}, params, {
    system: params.system + PROMPT,
    tools: (params.tools || []).concat([TOOL]),
  });
}

/** Per-request options for client.messages.create. The header rather than
 *  client.beta.messages: identity.meter() wraps client.messages.create, so
 *  this is the path on which every call is priced and charged. */
const REQUEST_OPTIONS = Object.freeze({ headers: Object.freeze({ 'anthropic-beta': BETA }) });

/** May a failed advised turn be asked again without the advisor? Yes, unless
 *  the failure is plainly not the advisor's: a bad key (401) fails the same
 *  way again, and a 429 is the executor's own rate limit, which the SDK has
 *  already retried. */
function shouldFallBack(err) {
  const status = err && err.status;
  return status !== 401 && status !== 429;
}

/** What to call a failure in the log line: the HTTP status, else the SDK
 *  error's name. */
function errorCode(err) {
  return String((err && (err.status || err.name)) || 'error');
}

/** Consultations that came back as an error inside a 200. The request did not
 *  fail - the executor carried on without that advice - so these are only
 *  worth a log line. Hitting max_uses is the cap working, not a failure. */
function consultErrors(response) {
  const out = [];
  for (const b of (response && response.content) || []) {
    const c = b && b.type === 'advisor_tool_result' ? b.content : null;
    if (c && c.type === 'advisor_tool_result_error' && c.error_code !== 'max_uses_exceeded') {
      out.push(String(c.error_code));
    }
  }
  return out;
}

module.exports = {
  TOOL_TYPE, BETA, MODEL, MAX_USES, MAX_TOKENS, TOOL, PROMPT, REQUEST_OPTIONS,
  mode, isPlanningAsk, wanted, withAdvisor, shouldFallBack, errorCode, consultErrors,
};
