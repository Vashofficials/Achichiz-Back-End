/**
 * Barcodes and scanning.
 *
 * Four rules shape this file.
 *
 * **1. A barcode is never silently replaced.** Assigning a new code to a variant
 * that already has one invalidates every label already printed and stuck to a
 * box; a scan of one of those then resolves to nothing. So it takes an explicit
 * `force: true`, and the response returns `previousBarcode` so the operator knows
 * reprinting is now required.
 *
 * **2. Bulk generation is all-or-nothing and cannot produce duplicates.**
 * Candidates are minted distinct within the batch, then checked against the codes
 * live variants already hold, in the same transaction that writes them and under
 * a row lock on the variants. `uq_variants_barcode` is still the guarantee — the
 * check exists so a clash is reported as a clash rather than as a constraint
 * violation naming neither line.
 *
 * **3. A scan moves nothing.** It resolves a code to a variant and returns what
 * the named operation needs to proceed. The endpoint that actually moves stock is
 * a separate call, made after a human has looked at what came back.
 *
 * **4. A label leaks nothing.** The QR payload carries the SKU and the barcode
 * and stops there: no cost, no supplier, no quantities. A printed label ends up on
 * a pallet in somebody else's yard, and unit cost on it is a negotiating position
 * handed to a courier.
 */

import { randomInt } from 'node:crypto';
import { db } from '../../config/db.js';
import { NotFoundError, UnprocessableError, type FieldIssue } from '../../lib/errors.js';
import * as countsService from '../admin-stock-counts/admin-stock-counts.service.js';
import * as repo from './admin-barcodes.repository.js';
import {
  ean13CheckDigit,
  isValidEan13,
  mintDistinctEan13,
  type DigitSource,
} from './admin-barcodes.ean13.js';
import type {
  BarcodeGenerationResult,
  BarcodeResponse,
  BulkGenerateBody,
  BulkGenerationResult,
  GenerateBarcodeBody,
  QrResponse,
  ScanBody,
  ScanResponse,
} from './admin-barcodes.schemas.js';

/**
 * CSPRNG digits.
 *
 * Predictable barcodes are not a confidentiality problem — they are printed on
 * the outside of boxes. The reason not to seed from the clock is collisions: a
 * time-seeded PRNG produces runs of near-identical values across a 500-line
 * batch, which is exactly where the retry budget gets spent.
 */
const cryptoDigits: DigitSource = (length: number): string => {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String(randomInt(0, 10));
  return out;
};

/** Mint `count` codes that clash with nothing in the batch and nothing already stored. */
async function mintFreeBarcodes(
  exec: Parameters<typeof repo.takenBarcodes>[0],
  prefix: string,
  count: number,
): Promise<string[]> {
  const exclude = new Set<string>();

  // Two rounds is enough in practice: the first mints, the second replaces
  // whatever the database says is taken. A third round would be evidence the
  // prefix is exhausted, and looping forever on that is worse than failing.
  for (let round = 0; round < 3; round += 1) {
    const candidates = mintDistinctEan13(prefix, count, cryptoDigits, { exclude });
    const taken = await repo.takenBarcodes(exec, candidates);
    if (taken.size === 0) return candidates;
    for (const code of taken) exclude.add(code);
  }

  throw new UnprocessableError(
    `Could not find ${count} unused EAN-13 codes under prefix '${prefix}'. That prefix is close to ` +
      'exhausted; generate under a different one from the `20`–`29` range.',
    'barcode_space_exhausted',
    { context: { prefix, count } },
  );
}

const toBarcodeResponse = (variant: repo.VariantRow): BarcodeResponse => {
  const valid = variant.barcode !== null && isValidEan13(variant.barcode);
  return {
    variantId: variant.id,
    sku: variant.sku,
    name: variant.name,
    barcode: variant.barcode,
    symbology: variant.barcode ? 'EAN13' : null,
    isValid: valid,
    checkDigit: valid && variant.barcode ? Number(variant.barcode[12]) : null,
  };
};

/* -------------------------------------------------------------- look-up */

export async function getBySku(sku: string): Promise<BarcodeResponse> {
  const variant = await repo.findVariantBySku(sku);
  if (!variant) throw new NotFoundError('Product variant', sku);
  return toBarcodeResponse(variant);
}

/* -------------------------------------------------------------- generate */

export async function generate(body: GenerateBarcodeBody): Promise<BarcodeGenerationResult> {
  return db.transaction(async (tx) => {
    const [variant] = await repo.lockVariantsBySkus(tx, [body.sku]);
    if (!variant) throw new NotFoundError('Product variant', body.sku);

    if (variant.barcode && !body.force) {
      // Not an error the caller can ignore: overwriting silently would make every
      // label already on a box scan to nothing.
      throw new UnprocessableError(
        `${variant.sku} already carries the barcode ${variant.barcode}` +
          `${isValidEan13(variant.barcode) ? '' : ' (which is not a valid EAN-13)'}. Assigning a new one ` +
          'invalidates every label already printed for this SKU, so it will not happen by accident. Re-send ' +
          'with `force: true` if you intend to reprint them.',
        'barcode_exists',
        { context: { sku: variant.sku, barcode: variant.barcode } },
      );
    }

    const [barcode] = await mintFreeBarcodes(tx, body.prefix, 1);
    if (!barcode) throw new Error('barcode minting returned nothing');

    const at = new Date();
    await repo.setBarcode(tx, variant.id, barcode, at);

    return {
      variantId: variant.id,
      sku: variant.sku,
      barcode,
      previousBarcode: variant.barcode,
      generated: true,
    };
  });
}

export async function bulkGenerate(body: BulkGenerateBody): Promise<BulkGenerationResult> {
  const requested = [...new Set(body.skus)];

  return db.transaction(async (tx) => {
    const variants = await repo.lockVariantsBySkus(tx, requested);
    const bySku = new Map(variants.map((v) => [v.sku, v]));

    // Front-loaded validation: unknown SKUs come back as field-level issues
    // BEFORE a single code is minted, because this endpoint is all-or-nothing
    // and a half-labelled batch is worse than a refused one.
    const unknown: FieldIssue[] = body.skus
      .map((sku, index) => ({ sku, index }))
      .filter(({ sku }) => !bySku.has(sku))
      .map(({ sku, index }) => ({
        path: `skus[${index}]`,
        code: 'unknown_sku',
        message: `No live product variant carries the SKU '${sku}'.`,
      }));
    if (unknown.length > 0) {
      throw new UnprocessableError(
        'Some SKUs do not exist. Nothing was written — this endpoint is all-or-nothing.',
        'unknown_sku',
        { issues: unknown },
      );
    }

    const needsCode = requested.filter((sku) => {
      const variant = bySku.get(sku);
      return variant ? body.force || variant.barcode === null : false;
    });

    const minted = await mintFreeBarcodes(tx, body.prefix, needsCode.length);
    const codeBySku = new Map(needsCode.map((sku, i) => [sku, minted[i]!]));

    const at = new Date();
    const results: BarcodeGenerationResult[] = [];

    for (const sku of requested) {
      const variant = bySku.get(sku);
      if (!variant) throw new NotFoundError('Product variant', sku);

      const barcode = codeBySku.get(sku);
      if (!barcode) {
        // Already had one and `force` was not set. Left exactly as it is, and
        // reported so the operator can see it was not a silent success.
        results.push({
          variantId: variant.id,
          sku: variant.sku,
          barcode: variant.barcode ?? '',
          previousBarcode: null,
          generated: false,
        });
        continue;
      }

      await repo.setBarcode(tx, variant.id, barcode, at);
      results.push({
        variantId: variant.id,
        sku: variant.sku,
        barcode,
        previousBarcode: variant.barcode,
        generated: true,
      });
    }

    return {
      assigned: results.filter((r) => r.generated).length,
      skipped: results.filter((r) => !r.generated).length,
      results,
    };
  });
}

/* ------------------------------------------------------------------ scan */

export async function scan(body: ScanBody): Promise<ScanResponse> {
  const byBarcode = await repo.findVariantByBarcode(body.barcode);
  // Labels printed from `GET /v1/admin/qr/:sku` carry the SKU, not the EAN-13. A
  // handheld should not have to know which kind of label it is pointed at, so the
  // SKU is a documented fallback and the response says which one matched.
  const variant = byBarcode ?? (await repo.findVariantBySku(body.barcode));

  if (!variant) {
    throw new NotFoundError('Barcode', body.barcode);
  }

  const levels = await repo.levelsForVariant(variant.id, body.warehouseId);

  // Only `stock_count` asks the question, so only `stock_count` pays for the
  // query. The other operations get the same variant-and-levels context, which is
  // what each of them actually needs to start.
  let activeCount: ScanResponse['activeCount'] = null;
  if (body.operation === 'stock_count') {
    for (const level of levels) {
      const open = await countsService.openCountForLevel(level.inventoryLevelId);
      if (open) {
        activeCount = {
          countId: open.countId,
          countNo: open.countNo,
          inventoryLevelId: open.inventoryLevelId,
          countItemId: open.countItemId,
          systemQty: open.systemQty,
          countedQty: open.countedQty,
          submitTo: `/v1/admin/stock-counts/${open.countId}/items`,
        };
        break;
      }
    }
  }

  return {
    matchedOn: byBarcode ? 'barcode' : 'sku',
    operation: body.operation,
    variantId: variant.id,
    sku: variant.sku,
    name: variant.name,
    barcode: variant.barcode,
    status: variant.status,
    levels: levels.map((l) => ({
      inventoryLevelId: l.inventoryLevelId,
      warehouseId: l.warehouseId,
      warehouseCode: l.warehouseCode,
      onHandQty: l.onHandQty,
      reservedQty: l.reservedQty,
      availableQty: l.availableQty ?? l.onHandQty - l.reservedQty,
      incomingQty: l.incomingQty,
      binLocation: l.binLocation,
      locationPath: l.locationPath,
    })),
    activeCount,
    movesStock: false,
  };
}

/* -------------------------------------------------------------------- QR */

export const QR_VERSION = 'ACH1' as const;

/**
 * The label payload, built in one place so what is printed and what is documented
 * cannot drift.
 *
 * Pure and exported for the test. Note what is NOT in it: unit cost, supplier,
 * on-hand quantity, warehouse. A label travels on the outside of a box into
 * somebody else's yard, and every one of those fields is either commercially
 * sensitive or wrong by the time it is read.
 */
export const qrPayload = (sku: string, barcode: string | null): string =>
  `${QR_VERSION}|${sku}|${barcode ?? ''}`;

export async function getQr(sku: string): Promise<QrResponse> {
  const variant = await repo.findVariantBySku(sku);
  if (!variant) throw new NotFoundError('Product variant', sku);

  return {
    sku: variant.sku,
    barcode: variant.barcode,
    name: variant.name,
    optionLabel: variant.optionLabel,
    payload: qrPayload(variant.sku, variant.barcode),
    version: QR_VERSION,
    symbology: 'QR',
    generatedAt: new Date().toISOString(),
  };
}

/** Re-exported so the check digit has one home and the route docs can name it. */
export { ean13CheckDigit, isValidEan13 };
