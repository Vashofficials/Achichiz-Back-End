/**
 * index.ts — the schema barrel.
 *
 * Repositories import ONLY from here:
 *     import { orders, orderLines, type Order } from '../db/schema/index.js';
 *
 * Never import a context file directly from application code. The twelve
 * context files exist to keep the schema readable and to make the cross-context
 * foreign keys explicit; they are an internal layout, not a public surface.
 *
 * This file also feeds `drizzle({ client, schema })`, which is what makes the
 * relational query API (`db.query.orders.findMany({ with: { lines: true } })`)
 * typed — so every table AND every `*Relations` object must be re-exported.
 *
 * NOTE: the SQL migration (../migrations/0001_initial.sql) is the authoritative
 * artifact. Domains, generated columns, exclusion constraints, functions and
 * every trigger — including the DEFERRABLE constraint triggers that enforce
 * "order total = sum of lines" — exist only there. See ./README.md.
 */

export * from './tax.js';
export * from './identity.js';
export * from './customers.js';
export * from './catalogue.js';
export * from './inventory.js';
export * from './orders.js';
export * from './payments.js';
export * from './corporate.js';
export * from './delivery.js';
export * from './promotions.js';
export * from './content.js';
export * from './platform.js';
