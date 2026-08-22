import { Router, type Request } from 'express';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { created, ok } from '../../lib/http.js';
import * as leads from './leads.service.js';
import {
  contactEnquiryBody,
  corporateBriefBody,
  leadReceived,
  newsletterBody,
  newsletterSubscribed,
} from './leads.schemas.js';

/**
 * Lead capture: contact enquiry, corporate gifting brief, newsletter.
 *
 * All three are public, all three are rate-limited with the `lead` limiter (10
 * per hour per IP), and all three replace a storefront form that currently
 * discards its own submission in the browser.
 *
 * These are the only unauthenticated write endpoints on the storefront surface
 * that take free text, which makes them the bot target. The limiter is the first
 * line; a captcha in front of the corporate form is the second and is a product
 * decision, not a code one.
 */
export const leadsRouter: Router = Router();

/**
 * `activity_logs.ip` and `corporate_leads` writes go through the `inet` type,
 * which rejects anything that is not an address. Behind the proxy Express hands
 * back `::ffff:127.0.0.1` (legal) or nothing at all; anything else becomes NULL
 * rather than failing the insert on a lead we would rather keep.
 */
const IP_SHAPE = /^[0-9a-fA-F:.]{3,45}$/;

const clientIp = (req: Request): string | null => {
  const raw = req.ip ?? req.socket.remoteAddress ?? '';
  return IP_SHAPE.test(raw) ? raw : null;
};

const SPAM_NOTE =
  'Rate-limited to 10 submissions per hour per IP. There is no captcha in front of this yet — if ' +
  'volume becomes a problem, that is the next control, not a tighter limiter.';

defineRoute(leadsRouter, {
  method: 'post',
  path: '/v1/leads/contact',
  surface: 'storefront',
  operationId: 'submitContactEnquiry',
  summary: 'Submit a contact enquiry',
  description:
    'Persists the enquiry as a lead, emails the team, and acknowledges the customer. ' +
    'Replaces `contact.tsx`, which today calls `preventDefault()`, shows a success toast and throws ' +
    'the message away. ' +
    '\n\n' +
    'The response carries a `reference` (`LD-00042`) issued from the row-locked document series — show ' +
    'it in the confirmation, because support can search on it. A phone number that is not an Indian ' +
    'ten-digit mobile is stored on the lead as free text rather than rejected; losing a genuine enquiry ' +
    'over a landline would be the wrong trade. ' +
    SPAM_NOTE,
  tags: ['Leads'],
  auth: 'public',
  rateLimit: 'lead',
  request: { body: contactEnquiryBody },
  responses: {
    201: { description: 'The enquiry is saved.', schema: leadReceived },
    429: { description: 'Too many submissions from this IP.' },
  },
  handler: async ({ body }) => created(await leads.submitContactEnquiry(body)),
});

defineRoute(leadsRouter, {
  method: 'post',
  path: '/v1/leads/corporate-gifting',
  surface: 'storefront',
  operationId: 'submitCorporateGiftingBrief',
  summary: 'Submit a corporate gifting brief',
  description:
    'The B2B pipeline’s front door, and the highest-value form on the site. Persists to the same lead ' +
    'board the sales team works from, tagged `website_corporate_form`. ' +
    '\n\n' +
    'The **25-unit minimum is enforced server-side**. The storefront expresses it as `min={25}` on an ' +
    '`<input>`, which any direct API call ignores; a brief for three mugs entering the corporate ' +
    'pipeline wastes a salesperson’s afternoon. ' +
    SPAM_NOTE,
  tags: ['Leads'],
  auth: 'public',
  rateLimit: 'lead',
  request: { body: corporateBriefBody },
  responses: {
    201: { description: 'The brief is saved.', schema: leadReceived },
    422: { description: 'Below the 25-unit minimum, or a field failed validation.' },
  },
  handler: async ({ body }) => created(await leads.submitCorporateBrief(body)),
});

defineRoute(leadsRouter, {
  method: 'post',
  path: '/v1/newsletter/subscribe',
  surface: 'storefront',
  operationId: 'subscribeToNewsletter',
  summary: 'Subscribe to the newsletter',
  description:
    'Adds the address to the marketing list and records the consent with a timestamp, a source and an ' +
    'IP — a boolean column alone cannot answer "prove when they opted in", which is the question the ' +
    'DPDP Act actually asks. ' +
    '\n\n' +
    'Idempotent and deliberately uninformative: the same `{ "status": "subscribed" }` comes back for a ' +
    'new address, for a customer who had opted out, and for one already on the list. A footer form that ' +
    'said "you already have an account" would be an account-existence oracle on every page. ' +
    '\n\n' +
    'The subscriber list and the account list are the same rows, so the footer form and the profile ' +
    'toggle cannot disagree. Double opt-in is not implemented — it is an open business question.',
  tags: ['Leads'],
  auth: 'public',
  rateLimit: 'lead',
  request: { body: newsletterBody },
  responses: {
    200: { description: 'Subscribed (or already subscribed).', schema: newsletterSubscribed },
    429: { description: 'Too many submissions from this IP.' },
  },
  handler: async ({ body, req }) =>
    ok(await leads.subscribeToNewsletter(body.email, body.source, clientIp(req))),
});
