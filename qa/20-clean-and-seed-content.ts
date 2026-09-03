/**
 * Take the QA junk off the live storefront, and give it real content.
 *
 * `/v1/testimonials` was publicly serving SEVEN rows named
 * "QA patched testimonials mth2vbao", and `/v1/faqs` a single FAQ reading
 * "Q: jhg / A: bvn". Both are test artifacts that were left `published`, which
 * means they are on the internet right now. Wiring the storefront to these
 * endpoints without this script would have put them on the homepage.
 *
 * Three things happen here:
 *
 *  1. QA artifacts are DEMOTED, not deleted — FAQs to `draft`, testimonials to
 *     `rejected`. Both leave the storefront immediately (the public queries
 *     filter on `published`) while staying visible in the Admin Panel, so
 *     nothing is destroyed and an operator can see what was removed.
 *
 *  2. The ten real FAQs are seeded. This is Achichiz's own published copy —
 *     materials, personalisation, corporate orders, delivery radius — which
 *     until now lived only inside the front-end's JS bundle, where no operator
 *     could edit it.
 *
 *  3. A `header` navigation menu is built FROM THE COLLECTIONS THAT EXIST.
 *     The hard-coded menu it replaces had twenty links, ELEVEN of which 404 —
 *     `lifestyle-bags`, `curated-hampers`, `for-her`, `birthday`,
 *     `festivals-diwali` and the rest were never created. Two whole groups
 *     ("Bags", "Occasions") were entirely dead. Building the menu from a live
 *     query makes that class of bug impossible: a link can only exist here if
 *     its collection does.
 *
 * TESTIMONIALS ARE NOT SEEDED. The four in the front-end fixture are quotes
 * attributed to four named people in named Lucknow neighbourhoods, and nobody
 * said them. Inventing customer reviews is not a content gap to fill — it is a
 * thing not to do. The storefront now hides the section when there are none,
 * so the correct action is for a human to add real, attributable ones in the
 * Admin Panel.
 */

import { RESOURCES } from '../src/modules/admin-resources/resource.registry.js';
import * as svc from '../src/modules/admin-resources/admin-resources.service.js';
import { db, closeDb } from './lib.js';

const faqsRes = RESOURCES.find((r) => r.slug === 'faqs')!;

/* ------------------------------------------------- 1. demote the QA junk */

console.log('--- demote QA artifacts ---');

/*
 * Matched on the QA harness's own naming, plus the short all-lowercase
 * keyboard-mash that a manual smoke test leaves behind. Anything a human
 * actually wrote is left alone.
 */
const QA_PATTERN = '(QA %|API Demo %|qa-%)';

const faqJunk = await db().query<{ question: string }>(
  `update faqs set status = 'draft', updated_at = now()
    where status = 'published'
      and (question similar to $1 or question ~ '^[a-z]{1,6}$' or answer ~ '^[a-z]{1,6}$')
    returning question`,
  [QA_PATTERN],
);
console.log(`  faqs         -> draft    : ${faqJunk.rowCount ?? 0}`);
for (const r of faqJunk.rows) console.log(`      "${r.question}"`);

const testiJunk = await db().query<{ author_name: string }>(
  `update testimonials set status = 'rejected', updated_at = now()
    where status = 'published' and (author_name similar to $1 or quote similar to $1)
    returning author_name`,
  [QA_PATTERN],
);
console.log(`  testimonials -> rejected : ${testiJunk.rowCount ?? 0}`);
for (const r of testiJunk.rows) console.log(`      "${r.author_name}"`);

/* ----------------------------------------------------- 2. the real FAQs */

const FAQS: { q: string; a: string; category: string }[] = [
  {
    category: 'About',
    q: 'What does Achichiz make?',
    a: 'Sustainable everyday goods — bamboo and cork workspace essentials, handcrafted jewellery, soy wax candles and eco lifestyle bags. Good for you, better for Earth.',
  },
  {
    category: 'About',
    q: 'Are your products really eco-friendly?',
    a: 'Yes. We work with bamboo, cork, wheat fibre, jute and cotton, use soy wax with cotton wicks, and ship in plastic-free recycled kraft packaging.',
  },
  {
    category: 'Orders',
    q: 'Can I personalise a gift?',
    a: 'Bottles, tumblers, diaries, pens, keychains and bags can be laser-engraved or printed with a name, date or logo. Options appear on the product page.',
  },
  {
    category: 'Corporate',
    q: 'Do you handle corporate and bulk orders?',
    a: 'Yes — from 25 units to 25,000, with branding, multi-address dispatch and a dedicated account manager. Share your brief on the Corporate Gifting page.',
  },
  {
    category: 'About',
    q: 'How is your jewellery made?',
    a: 'Every piece is handcrafted in small batches by artisan clusters. Slight variation in paint and finish is a sign of hand-work, not a defect.',
  },
  {
    category: 'Payment',
    q: 'Which payment methods do you accept?',
    a: 'UPI, credit and debit cards, net banking and major wallets. Cash on delivery is available on eligible pin codes and order values.',
  },
  {
    category: 'Delivery',
    q: 'How do I track my order?',
    a: 'You will receive tracking by email and SMS the moment your order is dispatched, and you can follow the timeline on the Track Order page.',
  },
  {
    category: 'Returns',
    q: 'What is your return policy?',
    a: 'Send us photographs within 48 hours of delivery for any damaged or incorrect item and we will replace it or refund you in full.',
  },
  {
    category: 'Delivery',
    q: 'Do you deliver outside Lucknow?',
    a: 'Right now we deliver across Lucknow only, usually within 1–3 working days with live tracking. Pan-India dispatch is planned in about a month, once our Lucknow service is fully proven.',
  },
  {
    category: 'Orders',
    q: 'Can I order a product that shows out of stock?',
    a: 'Our bags are currently in production. Write to us and we will add you to the waitlist and notify you the day stock lands.',
  },
];

console.log('\n--- real FAQs ---');
let position = 0;
for (const f of FAQS) {
  // Idempotent by question text, which is what an operator would search on.
  const { rows } = await db().query<{ id: string }>('select id from faqs where question = $1 limit 1', [
    f.q,
  ]);
  const body = {
    question: f.q,
    answer: f.a,
    category: f.category,
    position: position++,
    status: 'published',
  };
  if (rows[0]) {
    await svc.updateRow(faqsRes, rows[0].id, body);
    console.log(`  update  ${f.q}`);
  } else {
    await svc.createRow(faqsRes, body);
    console.log(`  create  ${f.q}`);
  }
}

/* --------------------------------------------- 3. the header navigation */

console.log('\n--- header menu ---');

const { rows: cols } = await db().query<{ id: string; handle: string; title: string }>(
  `select id, handle, title from collections where deleted_at is null and status = 'live'`,
);
const byHandle = new Map(cols.map((c) => [c.handle, c]));
console.log(`  ${cols.length} live collections available`);

/**
 * The grouping is a merchandising decision and stays here; the MEMBERSHIP is
 * checked against the database. A child whose collection does not exist is
 * dropped with a note rather than silently published as a dead link, and a
 * group left with no children is dropped entirely.
 */
const GROUPS: { label: string; children: { label: string; handle: string }[] }[] = [
  {
    label: 'Workspace',
    children: [
      { label: 'All Workspace', handle: 'workspace-collection' },
      { label: 'Bamboo Drinkware', handle: 'drinkware' },
      { label: 'Eco Stationery', handle: 'eco-stationery' },
    ],
  },
  {
    label: 'Jewellery',
    children: [
      { label: 'All Jewellery', handle: 'jewellery-collection' },
      { label: 'Necklaces & Sets', handle: 'necklaces' },
      { label: 'Earrings & Jhumkas', handle: 'earrings' },
    ],
  },
  {
    label: 'Candles',
    children: [
      { label: 'Earth & Aroma', handle: 'earth-aroma' },
      { label: 'Signature Picks', handle: 'signature-picks' },
    ],
  },
  {
    label: 'Gifting',
    children: [{ label: 'Best Sellers', handle: 'best-sellers' }],
  },
];

const { rows: menuRow } = await db().query<{ id: string }>(
  `insert into menus (key, name) values ('header', 'Header Navigation')
   on conflict (key) do update set name = excluded.name, updated_at = now()
   returning id`,
);
const menuId = menuRow[0]!.id;

// Items cascade from the menu, so rebuilding is a delete plus an insert.
await db().query('delete from menu_items where menu_id = $1', [menuId]);

let groupPos = 0;
let dropped = 0;
for (const g of GROUPS) {
  const children = g.children.filter((c) => {
    if (byHandle.has(c.handle)) return true;
    console.log(`    drop child  ${g.label} > ${c.label}  (no '${c.handle}' collection)`);
    dropped++;
    return false;
  });
  if (children.length === 0) {
    console.log(`  drop group  ${g.label}  (nothing live under it)`);
    continue;
  }

  // The group header itself links to its first live child, so the top-level
  // link can never point somewhere that does not exist either.
  const { rows: parent } = await db().query<{ id: string }>(
    `insert into menu_items (menu_id, parent_id, label, collection_id, position)
     values ($1, null, $2, $3, $4) returning id`,
    [menuId, g.label, byHandle.get(children[0]!.handle)!.id, groupPos++],
  );

  let childPos = 0;
  for (const c of children) {
    await db().query(
      `insert into menu_items (menu_id, parent_id, label, collection_id, position)
       values ($1, $2, $3, $4, $5)`,
      [menuId, parent[0]!.id, c.label, byHandle.get(c.handle)!.id, childPos++],
    );
  }
  console.log(`  ok    ${g.label.padEnd(12)} ${children.length} links`);
}

/* ---------------------------------------------------------------- verify */

const { rows: check } = await db().query<{ items: number; faqs: number; testi: number }>(
  `select (select count(*)::int from menu_items where menu_id = $1) as items,
          (select count(*)::int from faqs where status = 'published') as faqs,
          (select count(*)::int from testimonials where status = 'published') as testi`,
  [menuId],
);
const c = check[0]!;
console.log(`\nmenu items published  : ${c.items}   (${dropped} dead link(s) refused)`);
console.log(`FAQs published        : ${c.faqs}`);
console.log(`testimonials published: ${c.testi}   <-- add real ones in the Admin Panel`);

await closeDb();
