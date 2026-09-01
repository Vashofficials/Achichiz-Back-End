/**
 * Lead capture — the module that stops throwing enquiries away.
 *
 * Three rules shape everything below.
 *
 * 1. **Persist first, notify second.** The database write is awaited and its
 *    failure is the caller's failure; the email is best-effort and its failure is
 *    a log line. Getting that order wrong is how a working form starts returning
 *    502 because SES is having a bad afternoon — and losing the enquiry anyway,
 *    which is the exact behaviour this module exists to end.
 *
 * 2. **Notification is a seam, not an implementation.** `enqueueLeadNotifications`
 *    is the single extension point: today it awaits the SES adapter inline;
 *    tomorrow it pushes a BullMQ job (`bullmq` is already a dependency). Nothing
 *    else in this file knows how a lead gets announced.
 *
 * 3. **Consent is evidence, not a boolean.** `customers.marketing_opt_in` records
 *    the current state. `recordMarketingConsent` records *when*, *from where* and
 *    *from what IP*, in append-only `activity_logs` — which is the artefact a
 *    DPDP complaint actually asks for. Auth and account call in here rather than
 *    each writing their own consent row, so there is one shape to audit.
 */

import { db } from '../../config/db.js';
import { logger, requestContext } from '../../config/logger.js';
import { env } from '../../config/env.js';
import { defaultFrom, emailSender, maskEmail } from '../../integrations/email/index.js';
import * as repo from './leads.repository.js';
import type { ContactEnquiryBody, CorporateBriefBody } from './leads.schemas.js';

/* --------------------------------------------------------- pure utilities */

/**
 * `+91 98200 12345`, `098200-12345`, `9820012345` → `9820012345`; anything that
 * is not an Indian ten-digit mobile → null.
 *
 * `corporate_leads.mobile` is the `mobile_in` DOMAIN, which the database enforces
 * (`db/schema/README.md`). A contact form that accepts a landline must therefore
 * either normalise or store NULL — writing the raw string through would raise a
 * constraint violation on an enquiry we would rather keep.
 */
export function normaliseIndianMobile(input: string | undefined): string | null {
  if (!input) return null;
  const digits = input.replace(/\D/g, '');
  const local = digits.length > 10 ? digits.slice(-10) : digits;
  return /^[6-9][0-9]{9}$/.test(local) ? local : null;
}

/**
 * `corporate_leads.company_name` is NOT NULL, and a B2C contact enquiry has no
 * company. Filing it under the person's own name keeps the row honest and keeps
 * it findable through `idx_leads_search`, which indexes
 * `company_name || contact_name || email`. Inventing a placeholder like
 * "Individual" would make every such lead collide in that index and read as one
 * anonymous blob on the admin's board.
 */
export const companyNameFor = (company: string | undefined, contactName: string): string =>
  company?.trim() || contactName;

/** `Achichiz <connect@achiachi.in>` → `connect@achiachi.in`. */
export function addressOf(from: string): string {
  const angled = /<([^>]+)>/.exec(from);
  return (angled?.[1] ?? from).trim();
}

/* ------------------------------------------------- the notification seam */

export type LeadNotification = {
  kind: 'contact' | 'corporate';
  reference: string;
  contactName: string;
  email: string;
  summary: string;
  /** Rendered into the internal email as `Label: value` lines. */
  details: Record<string, string>;
};

/**
 * THE EXTENSION POINT.
 *
 * Everything a lead needs to trigger — internal alert, customer acknowledgement,
 * CRM push, Slack ping — goes through here, and nothing calls the email sender
 * directly.
 *
 * Right now it awaits two sends against the SES adapter, which is a logging no-op
 * until SES production access and DKIM on `notifications.achichiz.com` are in
 * place. To make it asynchronous, replace the body with a queue push:
 *
 * ```ts
 * await leadQueue.add('lead.received', notification, {
 *   attempts: 5,
 *   backoff: { type: 'exponential', delay: 5_000 },
 * });
 * ```
 *
 * and move the two `emailSender.send` calls into the worker. The call sites do
 * not change, and neither does the contract: **this function never throws.** A
 * lead that is safely in Postgres must not be reported to the customer as a
 * failure because a downstream notification did not go out.
 */
export async function enqueueLeadNotifications(notification: LeadNotification): Promise<void> {
  const inbox = addressOf(env.EMAIL_FROM);
  const detailLines = Object.entries(notification.details)
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');

  try {
    await emailSender.send({
      to: inbox,
      replyTo: notification.email,
      subject:
        notification.kind === 'corporate'
          ? `[${notification.reference}] Corporate gifting brief — ${notification.contactName}`
          : `[${notification.reference}] Contact enquiry — ${notification.contactName}`,
      text: `${detailLines}\n\n---\n${notification.summary}\n`,
    });
  } catch (err) {
    logger.error(
      { err, reference: notification.reference },
      'leads.internal_notification_failed — the lead IS saved; only the alert did not go out',
    );
  }

  try {
    await emailSender.send({
      to: notification.email,
      from: defaultFrom(),
      subject: 'We have your enquiry',
      text:
        `Hi ${notification.contactName},\n\n` +
        `Thank you for getting in touch with Achichiz. Your enquiry is with our team and someone will ` +
        `reply shortly.\n\n` +
        `Your reference is ${notification.reference} — quote it if you write in again.\n\n— Achichiz`,
    });
  } catch (err) {
    logger.error({ err, reference: notification.reference }, 'leads.acknowledgement_failed');
  }
}

/* --------------------------------------------------------------- capture */

async function createLead(values: {
  companyName: string;
  contactName: string;
  email: string;
  mobile: string | null;
  city: string | null;
  employeeCount: number | null;
  quantityNeeded: number | null;
  occasion: string | null;
  brief: string;
  source: string;
}): Promise<repo.LeadRow> {
  /*
   * One transaction, because `next_document_number()` takes a row lock on the
   * series and holds it until COMMIT. Issuing the number outside the insert would
   * either burn numbers on a failed insert or widen that lock across a second
   * round trip — and the series row is a global choke point for every lead.
   */
  return db.transaction(async (tx) => {
    const leadNo = await repo.nextLeadNumber(tx);
    return repo.insertLead(tx, { ...values, leadNo, stage: 'new' });
  });
}

export async function submitContactEnquiry(
  input: ContactEnquiryBody,
): Promise<{ status: 'received'; reference: string }> {
  const lead = await createLead({
    companyName: companyNameFor(input.company, input.name),
    contactName: input.name,
    email: input.email,
    mobile: normaliseIndianMobile(input.phone),
    city: null,
    employeeCount: null,
    quantityNeeded: null,
    occasion: null,
    brief: input.message,
    source: repo.LEAD_SOURCES.contact,
  });

  logger.info({ reference: lead.leadNo, email: maskEmail(input.email) }, 'leads.contact_enquiry_received');

  await enqueueLeadNotifications({
    kind: 'contact',
    reference: lead.leadNo,
    contactName: input.name,
    email: input.email,
    summary: input.message,
    details: {
      Name: input.name,
      Email: input.email,
      // The raw string, not the normalised one — if it was a landline the team
      // still needs to be able to ring it.
      Phone: input.phone ?? '—',
      Company: input.company ?? '—',
    },
  });

  return { status: 'received', reference: lead.leadNo };
}

export async function submitCorporateBrief(
  input: CorporateBriefBody,
): Promise<{ status: 'received'; reference: string }> {
  const lead = await createLead({
    companyName: input.company,
    contactName: input.name,
    email: input.workEmail,
    mobile: normaliseIndianMobile(input.mobile),
    city: input.city ?? null,
    employeeCount: input.employeeCount ?? null,
    quantityNeeded: input.quantity,
    occasion: input.occasion ?? null,
    brief: input.brief,
    source: repo.LEAD_SOURCES.corporate,
  });

  logger.info(
    { reference: lead.leadNo, company: input.company, quantity: input.quantity },
    'leads.corporate_brief_received',
  );

  await enqueueLeadNotifications({
    kind: 'corporate',
    reference: lead.leadNo,
    contactName: input.name,
    email: input.workEmail,
    summary: input.brief,
    details: {
      Name: input.name,
      Company: input.company,
      'Work email': input.workEmail,
      Mobile: input.mobile ?? '—',
      Quantity: String(input.quantity),
      Occasion: input.occasion ?? '—',
      'Employee count': input.employeeCount === undefined ? '—' : String(input.employeeCount),
      City: input.city ?? '—',
    },
  });

  return { status: 'received', reference: lead.leadNo };
}

/* --------------------------------------------------------------- consent */

export type ConsentSource = 'signup_form' | 'profile' | 'footer' | 'checkout' | 'popup';

/**
 * Records that consent was granted, with provenance.
 *
 * Called by `auth.service` on signup, by `account.service` when the profile
 * toggle is turned on, and by `subscribeToNewsletter` below. Never throws: a
 * failed audit write must not roll back a signup, and it is logged at error
 * level so the gap is visible rather than silent.
 */
export async function recordMarketingConsent(input: {
  customerId: string;
  source: ConsentSource;
  ip: string | null;
  label?: string | undefined;
}): Promise<void> {
  try {
    await repo.insertConsentLog({
      customerId: input.customerId,
      actorLabel: input.label ?? 'storefront customer',
      action: 'customer.marketing_consent_granted',
      before: { marketingOptIn: false },
      after: {
        marketingOptIn: true,
        source: input.source,
        consentedAt: new Date().toISOString(),
      },
      ip: input.ip,
      requestId: requestContext.getStore()?.requestId ?? null,
    });
  } catch (err) {
    logger.error({ err, customerId: input.customerId }, 'leads.consent_log_failed');
  }
}

/** The mirror image, for a withdrawal. Same evidentiary reason. */
export async function recordMarketingWithdrawal(input: {
  customerId: string;
  source: ConsentSource;
  ip: string | null;
}): Promise<void> {
  try {
    await repo.insertConsentLog({
      customerId: input.customerId,
      actorLabel: 'storefront customer',
      action: 'customer.marketing_consent_withdrawn',
      before: { marketingOptIn: true },
      after: { marketingOptIn: false, source: input.source, withdrawnAt: new Date().toISOString() },
      ip: input.ip,
      requestId: requestContext.getStore()?.requestId ?? null,
    });
  } catch (err) {
    logger.error({ err, customerId: input.customerId }, 'leads.consent_log_failed');
  }
}

/* ------------------------------------------------------------ newsletter */

/**
 * Subscribe an address.
 *
 * Idempotent, and silent about what it found: `{ status: 'subscribed' }` comes
 * back for a brand-new address, for an existing customer who had opted out, and
 * for one already subscribed. A footer form that answered "you already have an
 * account" would be an account-existence oracle sitting on every page of the
 * site.
 *
 * Subscribers land in `customers` with `marketing_opt_in = true` and nothing
 * else — no password, no name. That is the answer to 01_storefront_api §6 Q9:
 * the footer form and the profile toggle feed one list because they write the
 * same column on the same row, so an unsubscribe cannot half-apply.
 *
 * Double opt-in is **not** implemented and is a business decision (Q9). The
 * consent record written here says `source: 'footer'`, single opt-in; if the
 * answer comes back "double", the confirmation step slots in at
 * `enqueueLeadNotifications` and this function starts writing `marketing_opt_in`
 * only after the confirmation link is followed.
 */
export async function subscribeToNewsletter(
  email: string,
  source: ConsentSource,
  ip: string | null,
): Promise<{ status: 'subscribed' }> {
  const existing = await repo.findCustomerByEmail(email);

  if (existing) {
    if (!existing.marketingOptIn) {
      await repo.setMarketingOptIn(existing.id, true);
      await recordMarketingConsent({ customerId: existing.id, source, ip, label: email });
    }
    return { status: 'subscribed' };
  }

  const customer = await repo.insertSubscriberCustomer(email);
  await recordMarketingConsent({ customerId: customer.id, source, ip, label: email });
  logger.info({ email: maskEmail(email), source }, 'leads.newsletter_subscribed');
  return { status: 'subscribed' };
}
