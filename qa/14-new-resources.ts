/**
 * Do the three new descriptors actually work against the real tables?
 *
 * A descriptor typechecks whether or not its columns match the database — the
 * engine builds SQL from it at RUNTIME. So this drives the generic service the
 * way the routes do: list, create, read back, update, then remove. A wrong
 * column name or a CHECK the fields do not respect only shows up here.
 *
 * SAFETY: everything it creates is prefixed `api-demo-` per the brief's single
 * synthetic record rule, and is soft-deleted at the end. It touches no existing
 * row.
 */

import { resourceBySlug } from '../src/modules/admin-resources/resource.registry.js';
import * as svc from '../src/modules/admin-resources/admin-resources.service.js';
import { closeDb } from './lib.js';

const STAMP = Date.now().toString(36);

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = ''): void => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `\n        ${detail}` : ''}`);
};

const CASES: { slug: string; create: Record<string, unknown>; patch: Record<string, unknown> }[] = [
  {
    slug: 'hamper-items',
    create: { sku: `api-demo-hi-${STAMP}`, name: 'API Demo Hamper Item', costPaise: 25000, unit: 'pcs', status: 'active' },
    patch: { costPaise: 30000 },
  },
  {
    slug: 'add-ons',
    create: { code: `api-demo-addon-${STAMP}`, name: 'API Demo Wax Seal', kind: 'packaging', pricePaise: 25000, status: 'active' },
    patch: { pricePaise: 27500 },
  },
  {
    slug: 'personalisation',
    create: { name: `API Demo Engraving ${STAMP}`, method: 'engraving', turnaroundHours: 24, surchargePaise: 15000, status: 'draft' },
    patch: { surchargePaise: 20000 },
  },
  {
    slug: 'hamper-builder-templates',
    create: { handle: `api-demo-byoh-${STAMP}`, name: 'API Demo 4-Slot Premium Hamper', basePricePaise: 149900, status: 'draft' },
    patch: { basePricePaise: 159900 },
  },
];

for (const c of CASES) {
  console.log(`\n--- ${c.slug} ---`);
  const descriptor = resourceBySlug(c.slug);
  if (!descriptor) {
    check('descriptor is registered', false, 'resourceBySlug returned undefined');
    continue;
  }
  check('descriptor is registered', true);

  let id = '';
  try {
    const listed = await svc.listRows(descriptor, { page: 1, perPage: 5 } as never, {});
    check('LIST runs against the real table', Array.isArray(listed.items), JSON.stringify(listed).slice(0, 160));

    const created = (await svc.createRow(descriptor, c.create)) as { id: string };
    id = created.id;
    check('CREATE returns a row with an id', Boolean(id));

    const fetched = (await svc.readRow(descriptor, id, undefined)) as Record<string, unknown>;
    check('GET reads it back', Boolean(fetched?.['id']));

    const patchedKey = Object.keys(c.patch)[0]!;
    const updated = (await svc.updateRow(descriptor, id, c.patch)) as Record<string, unknown>;
    check(
      `PATCH applies ${patchedKey}`,
      updated[patchedKey] === c.patch[patchedKey],
      `expected ${String(c.patch[patchedKey])}, got ${String(updated[patchedKey])}`,
    );
  } catch (err) {
    check('the CRUD chain completed', false, (err as Error).message);
  } finally {
    if (id) {
      try {
        await svc.deleteRow(descriptor, id);
        check('DELETE removes it', (await svc.readRow(descriptor, id, undefined).catch(() => null)) === null);
      } catch (err) {
        check('DELETE removes it', false, (err as Error).message);
      }
    }
  }
}

console.log(`\n${pass}/${pass + fail} checks passed`);
await closeDb();
process.exit(fail === 0 ? 0 : 1);
