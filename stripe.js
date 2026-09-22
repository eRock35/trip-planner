// Stripe, without the SDK.
//
// Two calls and one signature check is the whole surface here, and the REST
// API is plain form-encoded POSTs. Pulling in the SDK for that would add a
// dependency tree to a container that currently has three packages, and this
// container cannot reach api.stripe.com at all - so the code has to be
// written to be correct from the docs rather than poked at interactively.
//
// The webhook signature check is the security-critical part. Anyone can POST
// to a webhook URL; only Stripe can sign the body.
//
// This lived in apps/dataviz/lib until 2026-09-22, when every app grew its own
// checkout so that pressing "AI credit" in the trip planner stops throwing the
// reader into DataViz. Creating a checkout session is now done by whichever
// app you are standing in; verifying the webhook is still done by exactly one
// service, because Stripe delivers to one endpoint and because
// STRIPE_WEBHOOK_SECRET has no reason to spread.
//
// COPY. The source is eriks-projects/shared/stripe.js - edit it there and run
// `node scripts/sync-shared.js`. CI fails if a copy drifts.

const crypto = require('crypto');

const API = 'https://api.stripe.com/v1';
const TOLERANCE_SECONDS = 300;

function secretKey() { return process.env.STRIPE_SECRET_KEY || ''; }
// The flat monthly fee: hosting and metering, not tokens. A separate Price
// from the old Pro one, because they grant different things and the webhook
// has to be able to tell which was bought.
function memberPriceId() { return process.env.STRIPE_MEMBER_PRICE_ID || ''; }
function webhookSecret() { return process.env.STRIPE_WEBHOOK_SECRET || ''; }

// Billing is on when there is a key and something to sell. That "something"
// is the membership now; the old Pro price used to be what this checked, so a
// deployment that still has STRIPE_PRICE_ID set but no membership price is
// correctly reported as having nothing to sell.
function enabled() { return Boolean(secretKey() && memberPriceId()); }
function membershipEnabled() { return enabled(); }

/** Stripe wants nested params as a[b][c]=v, not JSON. */
function form(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object' && !Array.isArray(v)) form(v, key, out);
    else if (Array.isArray(v)) v.forEach((item, i) => {
      if (typeof item === 'object') form(item, `${key}[${i}]`, out);
      else out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`);
    });
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out;
}

/**
 * The API version, and why there usually isn't one.
 *
 * This used to hardcode `Stripe-Version: 2026-08-27.basil`, which is not a
 * Stripe API version and never was: the current train is `dahlia`, and even
 * within basil there was no 08-27. Every call this file has ever made came
 * back `Invalid Stripe API version` - checkout, the billing portal, and the
 * price read behind /api/stripe/health, which has therefore been reporting
 * ok:false rather than confirming anything.
 *
 * It survived because it is untestable from here. This container cannot reach
 * api.stripe.com, the suites stub fetch, and no stub checked the header. A
 * string that only the real Stripe can judge should not be hardcoded by
 * someone who cannot ask it.
 *
 * So: no header by default, which means Stripe uses the account's default API
 * version - correct by construction, and the same version the webhook endpoint
 * renders events in. Set STRIPE_API_VERSION to pin one deliberately, once
 * somebody has actually confirmed it against the account. As of 2026-09-22 the
 * current version is `2026-08-26.dahlia`.
 *
 * (Organization API keys are the one case where Stripe REQUIRES the header.
 * This account uses a per-account restricted key, so it does not apply - and
 * if that ever changes, the failure is a loud 400 naming the header, not a
 * wrong charge.)
 */
function apiVersion() { return String(process.env.STRIPE_API_VERSION || '').trim(); }

async function call(path, body, method = 'POST') {
  const headers = {
    Authorization: `Bearer ${secretKey()}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  const version = apiVersion();
  if (version) headers['Stripe-Version'] = version;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? form(body).join('&') : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (data.error && data.error.message) || `Stripe ${res.status}`;
    throw Object.assign(new Error(message), { status: 502, stripe: data.error || null });
  }
  return data;
}

// createCheckout() - the $9 Pro subscription - was removed with the plan it
// sold. Keeping a function that mints a subscription nobody is offered is how
// a retired product comes back by accident.

// What a top-up can be bought in. Fixed amounts rather than a free-text box:
// an arbitrary-amount field invites typos and card-testing, and three choices
// cover the range anyone needs.
// Stripe takes 2.9% + $0.30 of every one of these, which is 8.9% of a $5
// top-up and 3.5% of a $50 one. The monthly fee is what absorbs that, so the
// floor is $10: below it the fee is paying Stripe rather than paying for
// hosting. Credit is sold 1:1 with what a call actually costs - the markup
// people normally take on tokens is the monthly fee instead.
const TOP_UPS = [
  { key: '10', usd: 10, label: '$10 of credit' },
  { key: '25', usd: 25, label: '$25 of credit' },
  { key: '50', usd: 50, label: '$50 of credit' },
];

// What the flat fee is, in one place, so the checkout page and the UI cannot
// disagree about it.
const MEMBERSHIP_USD = Number(process.env.MEMBERSHIP_USD || 5);

/**
 * The product tax code, which is not optional.
 *
 * Managed Payments is on by default on this account, and it refuses any line
 * item whose product has no tax code - so a top-up built from inline
 * price_data MUST carry one or checkout 400s before the buyer sees a card
 * field. The membership's stored Product needs the same thing set on it in
 * Stripe; there is nothing this file can do about that one.
 *
 * `txcd_10105001` is "Artificial Intelligence as a Service (AIaaS) - Cloud
 * Based - Personal Use", which is what this actually is: prepaid credit
 * against model calls made for you in the cloud. Stripe made the AIaaS codes
 * eligible for Managed Payments in June 2026.
 *
 * Personal rather than Business (`txcd_10105002`) because these are consumer
 * apps - trips, football, charts. If that ever stops being true, this is the
 * env var to flip, and the stored membership Product has to move with it.
 */
const TAX_CODE = String(process.env.STRIPE_TAX_CODE || 'txcd_10105001').trim();

/**
 * A one-off purchase of API credit, spendable across every app.
 *
 * `mode: 'payment'`, NOT subscription - and the webhook must tell them apart,
 * because the existing checkout.session.completed handler grants Pro. A credit
 * purchase that fell through that path would hand someone a subscription they
 * did not buy. `kind` in the metadata is what keeps them separate.
 *
 * The price is built inline rather than as a stored Price object so the set of
 * amounts can change without anything being created in the Stripe dashboard.
 */
async function createTopUp({ uid, email, usd, successUrl, cancelUrl, customerId }) {
  const option = TOP_UPS.find((t) => t.usd === Number(usd));
  if (!option) throw Object.assign(new Error('That is not a top-up amount.'), { status: 400 });
  const payload = {
    mode: 'payment',
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: option.usd * 100,
        product_data: {
          name: `${option.label} — Erik's apps`,
          description: 'Credit for AI requests, usable across every app on strongtechnicalconsulting.com.',
          tax_code: TAX_CODE,
        },
      },
    }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: uid,
    // `kind` is load-bearing: it is how the webhook knows not to grant Pro.
    metadata: { uid, kind: 'credit', creditUsd: String(option.usd) },
  };
  if (customerId) payload.customer = customerId;
  else if (email) payload.customer_email = email;
  return call('/checkout/sessions', payload);
}

/**
 * The flat monthly fee.
 *
 * This is what someone buys to use the apps on their own credit, or to bring
 * their own Anthropic key. It does not grant unlimited use and must not be
 * confused with the Pro subscription - see `kind` in the metadata, which is
 * what the webhook reads to decide which plan to write.
 */
async function createMembership({ uid, email, successUrl, cancelUrl, customerId }) {
  if (!memberPriceId()) {
    throw Object.assign(new Error('Membership is not configured.'), { status: 503 });
  }
  const payload = {
    mode: 'subscription',
    line_items: [{ price: memberPriceId(), quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: uid,
    metadata: { uid, kind: 'membership' },
    subscription_data: { metadata: { uid, kind: 'membership' } },
    allow_promotion_codes: true,
  };
  if (customerId) payload.customer = customerId;
  else if (email) payload.customer_email = email;
  return call('/checkout/sessions', payload);
}

/** The Stripe-hosted page where someone cancels or changes their card. Doing
 *  this ourselves would mean handling card details, which is the one thing
 *  using Stripe is meant to avoid. */
async function createPortal({ customerId, returnUrl }) {
  return call('/billing_portal/sessions', { customer: customerId, return_url: returnUrl });
}

/**
 * Verify a webhook came from Stripe.
 *
 * The signed payload is `${timestamp}.${rawBody}` - the RAW body, byte for
 * byte. If express.json() has already parsed and re-serialised it, the
 * signature will not match and the reason will not be obvious, so the webhook
 * route must be mounted with a raw body parser BEFORE the JSON one.
 */
function verifyWebhook(rawBody, signatureHeader) {
  const secret = webhookSecret();
  if (!secret) throw Object.assign(new Error('No STRIPE_WEBHOOK_SECRET is set.'), { status: 500 });
  if (!signatureHeader) throw Object.assign(new Error('No signature.'), { status: 400 });

  const parts = {};
  for (const piece of String(signatureHeader).split(',')) {
    const [k, v] = piece.split('=');
    if (k === 'v1') (parts.v1 = parts.v1 || []).push(v);
    else if (k) parts[k] = v;
  }
  if (!parts.t || !parts.v1 || !parts.v1.length) {
    throw Object.assign(new Error('Malformed signature.'), { status: 400 });
  }

  // A replayed old event is still correctly signed, so the age matters.
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(parts.t));
  if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) {
    throw Object.assign(new Error('Signature timestamp is outside the tolerance.'), { status: 400 });
  }

  const expected = crypto.createHmac('sha256', secret)
    .update(`${parts.t}.${rawBody.toString('utf8')}`)
    .digest('hex');

  // Stripe may send several v1 signatures during a secret rotation; any one
  // matching is enough.
  const ok = parts.v1.some((sig) => {
    if (typeof sig !== 'string' || sig.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  });
  if (!ok) throw Object.assign(new Error('Signature did not match.'), { status: 400 });

  return JSON.parse(rawBody.toString('utf8'));
}

module.exports = { enabled, membershipEnabled, apiVersion, createMembership, createTopUp, createPortal,
  verifyWebhook, call, form, memberPriceId, TOP_UPS, MEMBERSHIP_USD, TAX_CODE };
