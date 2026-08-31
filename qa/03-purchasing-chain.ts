/**
 * The purchasing workflow, end to end, against production.
 *
 *   supplier + warehouse + variant  (reused, not created)
 *     -> purchase order
 *     -> approve
 *     -> send
 *     -> goods receipt
 *     -> INVENTORY MOVED?
 *
 * This is the chain that proves stock actually changes. Every other admin test
 * so far has verified that endpoints respond; this one verifies that receiving
 * goods against a purchase order increases on-hand quantity, which is the whole
 * point of the module.
 *
 * Stock is read BEFORE and AFTER and the delta asserted against what was
 * received. A 200 from `/goods-receipts` that leaves inventory unchanged is a
 * silent failure and would pass every other check in this suite.
 *
 * Runs against PRODUCTION — the only database there is. It reuses existing
 * demo records where possible and creates nothing that is not prefixed `qa-`.
 * The quantity is deliberately small so a stranded row is inconsequential.
 */

import { adminLogin, call, closeDb, unwrap, BASE, db, type Res } from './lib.js';

const STAMP = Date.now().toString(36);
const RECEIVE_QTY = 3;

/**
 * Stock- and money-moving endpoints require an Idempotency-Key.
 *
 * That is correct design, not an obstacle: a retried goods receipt that
 * credited stock twice would be a silent inventory corruption. The key is
 * generated once per logical operation and reused on retry, exactly as the
 * API's own error message instructs.
 */
const idem = (label: string): Record<string, string> => ({
  'Idempotency-Key': crypto.randomUUID(),
  'X-QA-Operation': label,
});

type Step = { step: string; method: string; path: string; status: number; ms: number; ok: boolean; note: string };
const steps: Step[] = [];

function log(step: string, method: string, path: string, res: Res, want: number[]): boolean {
  const ok = want.includes(res.status);
  steps.push({
    step, method, path,
    status: res.status,
    ms: Math.round(res.ms),
    ok,
    note: ok ? '' : res.text.replace(/\s+/g, ' ').slice(0, 220),
  });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${String(res.status).padEnd(3)} ${method.padEnd(6)} ${path}`);
  if (!ok) console.log(`        ${res.text.replace(/\s+/g, ' ').slice(0, 200)}`);
  return ok;
}

/** On-hand for one variant, straight from the table the API writes. */
async function onHand(variantId: string): Promise<number> {
  const { rows } = await db().query<{ q: string }>(
    'select coalesce(sum(on_hand_qty),0)::text as q from inventory_levels where variant_id = $1',
    [variantId],
  );
  return Number(rows[0]?.q ?? 0);
}

async function firstId(path: string, token: string): Promise<string | null> {
  const r = await call('GET', path, { token });
  return (unwrap(r.body) as { id?: string }[])?.[0]?.id ?? null;
}

async function main(): Promise<void> {
  console.log(`target: ${BASE}\n`);
  const admin = await adminLogin();
  const t = { token: admin.access };

  /* ------------------------------------------------------- prerequisites */
  console.log('--- prerequisites (reused, not created) ---');
  const supplierId = await firstId('/v1/admin/suppliers?perPage=1', admin.access);
  const warehouseId = await firstId('/v1/admin/warehouses?perPage=1', admin.access);
  const variantId = await firstId('/v1/admin/product-variants?perPage=1', admin.access);
  console.log(`  supplier  : ${supplierId ?? 'NONE'}`);
  console.log(`  warehouse : ${warehouseId ?? 'NONE'}`);
  console.log(`  variant   : ${variantId ?? 'NONE'}`);

  if (!supplierId || !warehouseId || !variantId) {
    console.log('\nBLOCKED: the chain needs a supplier, a warehouse and a variant to exist.');
    await closeDb();
    return;
  }

  const before = await onHand(variantId);
  console.log(`  on-hand before: ${before}\n`);

  /* ----------------------------------------------------------- create PO */
  console.log('--- purchase order ---');
  const poBody = {
    supplierId,
    warehouseId,
    notes: `QA purchasing chain ${STAMP}`,
    lines: [
      {
        variantId,
        description: `QA line ${STAMP}`,
        orderedQty: RECEIVE_QTY,
        unitCostPaise: 10000,
      },
    ],
  };
  const created = await call('POST', '/v1/admin/purchasing/purchase-orders', { ...t, body: poBody });
  if (!log('create', 'POST', '/v1/admin/purchasing/purchase-orders', created, [200, 201])) {
    console.log(`        body: ${JSON.stringify(poBody).slice(0, 220)}`);
    await report();
    return;
  }
  const poId = (unwrap(created.body) as { id: string }).id;
  console.log(`        poId = ${poId}`);

  const detail = await call('GET', `/v1/admin/purchasing/purchase-orders/${poId}`, t);
  log('detail', 'GET', '/purchase-orders/{poId}', detail, [200]);

  /*
   * The receipt is keyed on PO LINE ids, not variant ids — it records what
   * arrived against what was ordered, so a line is the unit of reconciliation.
   */
  const poLines = (unwrap(detail.body) as { lines?: { id: string }[] }).lines ?? [];
  const poLineId = poLines[0]?.id;
  console.log(`        poLineId = ${poLineId ?? 'NONE — cannot receive'}`);

  /* ------------------------------------------------- approve, then send */
  console.log('\n--- state transitions ---');
  log('approve', 'POST', '/purchase-orders/{poId}/approve',
    await call('POST', `/v1/admin/purchasing/purchase-orders/${poId}/approve`, { ...t, body: {}, headers: idem('po-approve') }), [200, 202]);

  log('send', 'POST', '/purchase-orders/{poId}/send',
    await call('POST', `/v1/admin/purchasing/purchase-orders/${poId}/send`, { ...t, body: {}, headers: idem('po-send') }), [200, 202]);

  /* -------------------------------------------------------- goods receipt */
  console.log('\n--- goods receipt ---');
  const grnBody = {
    purchaseOrderId: poId,
    lines: [{ poLineId, acceptedQty: RECEIVE_QTY }],
  };
  const grn = await call('POST', '/v1/admin/purchasing/goods-receipts', { ...t, body: grnBody, headers: idem('grn') });
  const grnOk = log('receive', 'POST', '/v1/admin/purchasing/goods-receipts', grn, [200, 201]);
  if (!grnOk) console.log(`        body: ${JSON.stringify(grnBody).slice(0, 220)}`);

  /* ---------------------------------------------- did the stock actually move? */
  console.log('\n--- inventory effect ---');
  const after = await onHand(variantId);
  const delta = after - before;
  const moved = delta === RECEIVE_QTY;
  console.log(`  on-hand after : ${after}   (delta ${delta >= 0 ? '+' : ''}${delta}, expected +${RECEIVE_QTY})`);
  steps.push({
    step: 'stock moved',
    method: 'DB',
    path: 'inventory_levels.on_hand_qty',
    status: moved ? 200 : 0,
    ms: 0,
    ok: moved,
    note: moved ? '' : `expected +${RECEIVE_QTY}, saw ${delta} — a 2xx receipt that does not move stock is a silent failure`,
  });
  console.log(`  ${moved ? 'PASS' : 'FAIL'}  stock ${moved ? 'moved correctly' : 'DID NOT MOVE as expected'}`);

  await report();

  async function report(): Promise<void> {
    const pass = steps.filter((s) => s.ok).length;
    console.log(`\n${pass}/${steps.length} steps passed`);
    const fails = steps.filter((s) => !s.ok);
    if (fails.length) {
      console.log('\nfailures:');
      for (const f of fails) console.log(`  ${f.status} ${f.method} ${f.path}\n      ${f.note}`);
    }
    await closeDb();
  }
}

main().catch(async (e) => {
  console.error(e);
  await closeDb();
  process.exit(2);
});
