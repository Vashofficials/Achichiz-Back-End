/**
 * Drizzle queries for lead capture. No business rules, no HTTP.
 *
 * ## Where these rows land, and why
 *
 * The shipped 118-table schema has **no `contact_enquiries` and no
 * `newsletter_subscribers` table**, and `src/db/**` is not this module's to
 * change. Two mappings follow from that, and both are deliberate rather than
 * convenient:
 *
 *  - **Enquiries and briefs → `corporate_leads`.** It is the only enquiry
 *    pipeline in the schema, it already carries the exact columns both forms
 *    collect (contact, email, mobile, city, quantity, occasion, brief, source,
 *    stage, owner, follow-up date), and it is the table the admin's lead board
 *    reads. The two form types are told apart by `source`. A B2C contact enquiry
 *    is not literally a corporate lead — see the note on `LEAD_SOURCES`.
 *
 *  - **Newsletter subscribers → `customers.marketing_opt_in`.** 01_storefront_api
 *    §6 Q9 asks whether the footer form and the profile toggle should feed one
 *    list; making the subscriber *be* the customer row answers yes structurally,
 *    so unsubscribing in one place cannot leave the other still sending. A
 *    subscriber with no password and no orders is simply a customer who has not
 *    bought anything yet — which is what they are.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, type Executor, type Tx } from '../../config/db.js';
import { activityLogs, corporateLeads, customers } from '../../db/schema/index.js';

export type LeadRow = typeof corporateLeads.$inferSelect;
export type CustomerRow = typeof customers.$inferSelect;

/**
 * Distinguishes the two web forms — and anything sales enters by hand — inside
 * the one pipeline table. Kept as a const union so the admin's filters and this
 * module cannot drift apart on a string literal.
 */
export const LEAD_SOURCES = {
  contact: 'website_contact_form',
  corporate: 'website_corporate_form',
} as const;

/* --------------------------------------------------------- lead numbering */

/**
 * `LD-00001`, from the row-locked document series — not `Math.random()`, which is
 * how the storefront currently invents order numbers (`checkout.tsx:92`).
 *
 * The initial migration seeds only the statutory series (invoice, credit note,
 * quotation, …), so the `lead` series is created on first use exactly as
 * `checkout.repository.nextOrderNumber` creates the `order` one. `ON CONFLICT DO
 * NOTHING` makes that a no-op for every lead after the first, and safe under
 * concurrency: a second transaction blocks on the unique index and then finds the
 * row already present.
 *
 * `next_document_number()` participates in this transaction, so a rolled-back
 * lead does not burn a number. Gaplessness is not a legal requirement for a lead
 * number the way it is for an invoice — it is simply free here.
 */
export async function nextLeadNumber(tx: Tx): Promise<string> {
  await tx.execute(sql`
    INSERT INTO document_number_series (doc_type, scope_key, prefix, suffix, pad_width, next_value)
    VALUES ('lead', '', 'LD-', '', 5, 1)
    ON CONFLICT (doc_type, scope_key) DO NOTHING`);

  const result = await tx.execute<{ lead_no: string }>(
    sql`SELECT next_document_number('lead', '') AS lead_no`,
  );
  const leadNo = result.rows[0]?.lead_no;
  if (!leadNo) throw new Error('next_document_number returned no lead number');
  return leadNo;
}

/* ------------------------------------------------------------------ leads */

export async function insertLead(
  tx: Tx,
  values: Omit<typeof corporateLeads.$inferInsert, 'leadNo'> & { leadNo: string },
): Promise<LeadRow> {
  const rows = await tx.insert(corporateLeads).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('corporate lead insert returned no row');
  return row;
}

/* -------------------------------------------------------------- customers */

export async function findCustomerByEmail(
  email: string,
  exec: Executor = db,
): Promise<CustomerRow | null> {
  // `customers.email` is CITEXT — this comparison is already case-insensitive,
  // and a `lower()` wrapper would defeat `uq_customers_email`.
  const rows = await exec
    .select()
    .from(customers)
    .where(and(eq(customers.email, email), isNull(customers.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function insertSubscriberCustomer(
  email: string,
  exec: Executor = db,
): Promise<CustomerRow> {
  const rows = await exec
    .insert(customers)
    .values({ email, marketingOptIn: true })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('customer insert returned no row');
  return row;
}

export async function setMarketingOptIn(
  customerId: string,
  optIn: boolean,
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(customers)
    .set({ marketingOptIn: optIn, updatedAt: new Date() })
    .where(eq(customers.id, customerId));
}

/* ----------------------------------------------------------- consent log */

/**
 * The consent record itself.
 *
 * `activity_logs` is append-only and Tier 1 (the app role has no DELETE on it),
 * which is what makes it the right home for a consent artefact: the question a
 * DPDP notice actually asks is "prove when and how this person opted in", and a
 * boolean column on `customers` cannot answer that — it only holds the current
 * state.
 */
export async function insertConsentLog(
  values: {
    customerId: string;
    actorLabel: string;
    action: string;
    before: unknown;
    after: unknown;
    ip: string | null;
    requestId: string | null;
  },
  exec: Executor = db,
): Promise<void> {
  await exec.insert(activityLogs).values({
    actorKind: 'customer',
    actorCustomerId: values.customerId,
    actorLabel: values.actorLabel,
    action: values.action,
    entityType: 'customer',
    entityId: values.customerId,
    beforeData: values.before,
    afterData: values.after,
    changedFields: ['marketing_opt_in'],
    ip: values.ip,
    requestId: values.requestId,
  });
}
