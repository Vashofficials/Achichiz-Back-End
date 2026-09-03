/**
 * A live Build Your Own Hamper template, assembled from real catalogue rows.
 *
 * `/v1/hamper-builder/templates` answered with an empty list, so the BYOH page
 * had nothing to render even once it was wired to the API. The one template in
 * the database was a draft left by a CRUD test.
 *
 * Every option here points at a REAL product variant, at that variant's real
 * price. The page previously showed nineteen invented items — truffles,
 * pralines, baklava — that exist in no table, at prices nobody set. Those are
 * gone; what a shopper can put in a hamper is now exactly what the catalogue
 * sells, and changing a price in the Admin Panel changes it here.
 *
 * Idempotent: the template is found by handle and its steps rebuilt, so
 * re-running re-syncs rather than duplicating.
 */

import { RESOURCES } from '../src/modules/admin-resources/resource.registry.js';
import * as svc from '../src/modules/admin-resources/admin-resources.service.js';
import { db, closeDb } from './lib.js';

const HANDLE = 'signature-hamper';
const templatesRes = RESOURCES.find((r) => r.slug === 'hamper-builder-templates')!;

/* ------------------------------------------------------------- the template */

const existing = await db().query<{ id: string }>(
  'select id from builder_templates where handle = $1 and deleted_at is null limit 1',
  [HANDLE],
);

let templateId: string;
if (existing.rows[0]) {
  templateId = existing.rows[0].id;
  await svc.updateRow(templatesRes, templateId, {
    name: 'Signature Hamper',
    basePricePaise: 29900,
    status: 'live',
  });
  console.log(`reused template ${HANDLE}`);
} else {
  const row = (await svc.createRow(templatesRes, {
    handle: HANDLE,
    name: 'Signature Hamper',
    // Covers the eco-friendly, plastic-free packaging the studio always uses —
    // the page charges this as its base, on top of whatever is chosen.
    basePricePaise: 29900,
    maxWeightGrams: 5000,
    status: 'live',
  })) as { id: string };
  templateId = row.id;
  console.log(`created template ${HANDLE}`);
}

/* ------------------------------------------------------------- the steps */

/*
 * Steps are rebuilt rather than patched. Options cascade from the step, so a
 * delete-and-recreate keeps the template exactly in step with the catalogue
 * without diffing every option.
 */
await db().query('delete from builder_template_steps where template_id = $1', [templateId]);

type StepSpec = { title: string; note: string; min: number; max: number; match: RegExp };

const STEPS: StepSpec[] = [
  { title: 'Snacks & keepsakes', note: 'Choose 2 to 4', min: 2, max: 4, match: /candle|sachet/i },
  { title: 'Desk & drinkware', note: 'Choose up to 2', min: 0, max: 2, match: /bottle|tumbler|mug|diary|pen\b/i },
  { title: 'Jewellery & accessories', note: 'Choose up to 2', min: 0, max: 2, match: /necklace|pendant|jhumka|earring|dangler|keychain|card ?holder/i },
];

/** Live variants with a real price — nothing draft, nothing unpriced. */
const { rows: variants } = await db().query<{ id: string; title: string; price: number; weight: number | null }>(
  `select v.id, p.title, v.price_paise::int as price, v.weight_grams as weight
     from product_variants v
     join products p on p.id = v.product_id
    where v.deleted_at is null and p.deleted_at is null
      and v.status = 'active' and p.status = 'active'
      and p.published_at is not null and p.published_at <= now()
    order by p.title`,
);
console.log(`\n${variants.length} live variants available as options`);

let position = 0;
for (const spec of STEPS) {
  const matches = variants.filter((v) => spec.match.test(v.title)).slice(0, 12);
  if (matches.length === 0) {
    console.log(`  skip  ${spec.title} — nothing in the catalogue matches`);
    continue;
  }

  const { rows: step } = await db().query<{ id: string }>(
    `insert into builder_template_steps (template_id, position, title, note, min_choices, max_choices, step_kind)
     values ($1,$2,$3,$4,$5,$6,'items') returning id`,
    [templateId, position++, spec.title, spec.note, spec.min, Math.max(spec.max, spec.min)],
  );

  let i = 0;
  for (const v of matches) {
    await db().query(
      `insert into builder_step_options (step_id, variant_id, label, price_paise, weight_grams, position, is_available)
       values ($1,$2,$3,$4,$5,$6,true)`,
      [step[0]!.id, v.id, v.title, v.price, v.weight, i++],
    );
  }
  console.log(`  ok    ${spec.title.padEnd(26)} ${matches.length} options`);
}

/* personalisation and review carry no options; the page renders its own form */
await db().query(
  `insert into builder_template_steps (template_id, position, title, note, min_choices, max_choices, step_kind)
   values ($1,$2,'Card & personalisation','Optional',0,1,'personalisation'),
          ($1,$3,'Review hamper','',0,1,'review')`,
  [templateId, position, position + 1],
);

/* ---------------------------------------------------------------- verify */

const { rows: check } = await db().query<{ steps: number; options: number }>(
  `select (select count(*)::int from builder_template_steps where template_id=$1) as steps,
          (select count(*)::int from builder_step_options o
             join builder_template_steps s on s.id=o.step_id where s.template_id=$1) as options`,
  [templateId],
);
console.log(`\ntemplate now has ${check[0]!.steps} steps and ${check[0]!.options} options`);

await closeDb();
