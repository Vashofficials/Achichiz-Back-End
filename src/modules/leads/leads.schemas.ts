/**
 * Lead-capture contracts — contact enquiry, corporate gifting brief, newsletter.
 *
 * These three forms are, today, the highest-value thing missing from the
 * backend. All three are `e.preventDefault()` followed by `toast.success(...)`
 * in the storefront (`contact.tsx:62-66`, `corporate-gifting.tsx:66-70`,
 * `Footer.tsx:79-86`): the customer is told "we'll be in touch", and the
 * submission is discarded in the browser. Every corporate gifting enquiry the
 * site has ever received has been thrown away.
 *
 * The request shapes below match those forms field-for-field, so wiring them up
 * is a `fetch` call in each `onSubmit` and nothing else.
 */

import { z } from 'zod';

/** DB DOMAIN `mobile_in`. Ten digits, 6-9 leading, no country code. */
const MOBILE_IN = /^[6-9][0-9]{9}$/;

/**
 * Contact-form phone is looser than `mobile_in` on purpose: it is stored on a
 * lead, not used to authenticate anybody, and rejecting a landline or a number
 * typed with spaces would lose a genuine enquiry over formatting.
 */
const phone = z
  .string()
  .trim()
  .min(6)
  .max(20)
  .regex(/^[0-9+\-\s()]+$/, 'Digits, spaces and + - ( ) only.')
  .describe('Contact number as typed. Stored as given; only Indian ten-digit numbers are normalised.');

export const contactEnquiryBody = z.object({
  name: z.string().trim().min(2).max(120).describe('Who is writing in.'),
  email: z.email().max(255).describe('Where the reply goes. The only field the reply strictly needs.'),
  phone: phone.optional().describe('Optional call-back number.'),
  message: z
    .string()
    .trim()
    .min(10, 'Tell us a little more — ten characters minimum.')
    .max(4000)
    .describe('The enquiry itself. Stored verbatim on the lead as its brief.'),
  company: z
    .string()
    .trim()
    .max(160)
    .optional()
    .describe('Optional. Supplied, the enquiry is filed against the company; otherwise against the person.'),
});

export const corporateBriefBody = z.object({
  name: z.string().trim().min(2).max(120).describe('The buyer’s name.'),
  company: z.string().trim().min(2).max(160).describe('Company the gifting programme is for.'),
  workEmail: z.email().max(255).describe('Work email address. Proposals and quotations go here.'),
  quantity: z
    .number()
    .int()
    .min(25, 'Corporate gifting starts at 25 units.')
    .max(1_000_000)
    .describe(
      'Units needed. The 25-unit minimum is enforced **here**, server-side — the storefront’s ' +
        '`min={25}` is an HTML attribute and a direct API call ignores it.',
    ),
  brief: z
    .string()
    .trim()
    .min(10)
    .max(4000)
    .describe('Free-text brief: occasion, budget, branding, timelines.'),
  mobile: z
    .string()
    .regex(MOBILE_IN, 'An Indian mobile number is ten digits starting 6-9.')
    .optional()
    .describe('Optional direct line. Corporate leads convert far faster on a call than on email.'),
  occasion: z
    .string()
    .trim()
    .max(120)
    .optional()
    .describe('Diwali, onboarding kits, client appreciation, …'),
  employeeCount: z
    .number()
    .int()
    .positive()
    .max(10_000_000)
    .optional()
    .describe('Headcount, when known. Drives programme sizing.'),
  city: z.string().trim().max(80).optional().describe('Delivery city, when known.'),
});

export const newsletterBody = z.object({
  email: z.email().max(255).describe('The address to subscribe. Case-insensitive — stored CITEXT.'),
  source: z
    .enum(['footer', 'profile', 'checkout', 'popup'])
    .default('footer')
    .describe('Which control the customer used. Recorded with the consent, because consent needs provenance.'),
});

/* -------------------------------------------------------------- responses */

export const leadReceived = z.object({
  status: z.literal('received').describe('The enquiry is persisted. It is no longer only a toast.'),
  reference: z
    .string()
    .describe('Human-quotable lead number, e.g. `LD-00042`. Give it to the customer; support can search on it.'),
});

export const newsletterSubscribed = z.object({
  status: z
    .literal('subscribed')
    .describe(
      'Always `subscribed`, including for an address that was already on the list. Re-subscribing is ' +
        'idempotent and is not an error.',
    ),
});

export type ContactEnquiryBody = z.infer<typeof contactEnquiryBody>;
export type CorporateBriefBody = z.infer<typeof corporateBriefBody>;
export type NewsletterBody = z.infer<typeof newsletterBody>;
