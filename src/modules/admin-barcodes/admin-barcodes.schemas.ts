/**
 * Barcode and scanning contracts.
 *
 * There is no barcode registry table and this module does not create one:
 * `product_variants.barcode` is the column, `uq_variants_barcode` (partial, live
 * rows only) is the uniqueness guarantee, and a second table would be a second
 * answer to "what is this SKU's barcode".
 */

import { z } from 'zod';
import { INTERNAL_PREFIXES } from './admin-barcodes.ean13.js';

/** The operations a scan can be the front of. Scanning itself never moves stock. */
export const SCAN_OPERATIONS = [
  'stock_count',
  'receive',
  'transfer',
  'pick',
  'pack',
  'dispatch',
  'return',
] as const;
export type ScanOperation = (typeof SCAN_OPERATIONS)[number];

/* ------------------------------------------------------------ path params */

export const skuParam = z.object({
  sku: z.string().trim().min(1).max(64).describe('SKU of a product variant.'),
});

/* -------------------------------------------------------------- responses */

export const barcodeResponse = z.object({
  variantId: z.uuid().describe('Product variant id.'),
  sku: z.string().describe('Our SKU.'),
  name: z.string().nullable().describe('Product title plus option label.'),
  barcode: z.string().nullable().describe('EAN-13, or null when the variant has never been assigned one.'),
  symbology: z
    .literal('EAN13')
    .nullable()
    .describe('Always `EAN13` when a barcode is present. This module mints nothing else.'),
  isValid: z
    .boolean()
    .describe(
      'Whether the stored value is a well-formed EAN-13 whose check digit agrees with its payload. False on ' +
        'a legacy or hand-typed value — worth surfacing, because a bad check digit means the label on the ' +
        'shelf and the row in the database disagree.',
    ),
  checkDigit: z.number().int().nullable().describe('The 13th digit, when the stored value is a valid EAN-13.'),
});

export const barcodeGenerationResult = z.object({
  variantId: z.uuid().describe('Product variant id.'),
  sku: z.string().describe('Our SKU.'),
  barcode: z.string().describe('The EAN-13 now stored on the variant.'),
  previousBarcode: z
    .string()
    .nullable()
    .describe('What it replaced. Non-null only when `force: true` was passed — reprinting is now required.'),
  generated: z
    .boolean()
    .describe('False when the variant already had a valid barcode and it was returned unchanged.'),
});

export const bulkGenerationResult = z.object({
  assigned: z.number().int().describe('Variants given a new barcode.'),
  skipped: z.number().int().describe('Variants that already had one and were left alone (`force: false`).'),
  results: z.array(barcodeGenerationResult).describe('One entry per requested SKU, in the order they were sent.'),
});

/* --------------------------------------------------------------- generate */

export const generateBarcodeBody = z.object({
  sku: z.string().trim().min(1).max(64).describe('SKU of the variant to assign a barcode to.'),
  prefix: z
    .enum(INTERNAL_PREFIXES)
    .default('29')
    .describe(
      'GS1 restricted-circulation prefix (`20`–`29`). These are reserved for codes meaningful inside one ' +
        'company and can never collide with a manufacturer’s registered GS1 prefix. Goods sold through ' +
        'retail need a real GS1 company prefix, which is bought rather than generated — this endpoint ' +
        'cannot mint one and the default makes that obvious.',
    ),
  force: z
    .boolean()
    .default(false)
    .describe(
      'Overwrite an existing barcode. Refused without it: every label already printed for that SKU becomes ' +
        'wrong the moment the column changes, and a scan of an old label then resolves to nothing.',
    ),
});

export const bulkGenerateBody = z.object({
  skus: z
    .array(z.string().trim().min(1).max(64))
    .min(1)
    .max(500)
    .describe('Up to 500 SKUs. All-or-nothing — one unknown SKU writes nothing.'),
  prefix: z.enum(INTERNAL_PREFIXES).default('29').describe('As on the single-SKU endpoint.'),
  force: z
    .boolean()
    .default(false)
    .describe('Overwrite variants that already have a barcode. Without it they are skipped and reported as such.'),
});

/* ------------------------------------------------------------------- scan */

export const scanBody = z.object({
  barcode: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .describe(
      'What the scanner read. Matched against `product_variants.barcode` first, then against `sku` — labels ' +
        'printed from `GET /v1/admin/qr/:sku` carry the SKU, and a handheld should not care which kind of ' +
        'label it is pointed at. The response says which matched.',
    ),
  operation: z
    .enum(SCAN_OPERATIONS)
    .describe('What the operator is about to do. It selects the context returned; it does not perform anything.'),
  warehouseId: z
    .uuid()
    .optional()
    .describe('Narrow the returned levels to one warehouse — the one the handheld is standing in.'),
});

export const scanLevel = z.object({
  inventoryLevelId: z.uuid().describe('The (variant, warehouse) level.'),
  warehouseId: z.uuid().describe('Warehouse.'),
  warehouseCode: z.string().nullable().describe('Warehouse short code.'),
  onHandQty: z.number().int().describe('Physically present.'),
  reservedQty: z.number().int().describe('Already promised to a cart, order or hold.'),
  availableQty: z.number().int().describe('`onHandQty − reservedQty`, the GENERATED column.'),
  incomingQty: z.number().int().describe('On a sent purchase order, not yet received.'),
  binLocation: z.string().nullable().describe('Free-text bin on the level.'),
  locationPath: z.string().nullable().describe('Materialised location path, e.g. `A/R3/S2/B7`.'),
});

export const scanActiveCount = z.object({
  countId: z.uuid().describe('The in-progress count this level is on.'),
  countNo: z.string().describe('`CNT-2026-00001`.'),
  inventoryLevelId: z.uuid().describe('Which level the line belongs to.'),
  countItemId: z.uuid().describe('The count line to submit against.'),
  systemQty: z.number().int().describe('The frozen figure the variance will be measured against.'),
  countedQty: z.number().int().nullable().describe('What has already been counted, or null if not yet.'),
  submitTo: z
    .string()
    .describe('The endpoint to POST the counted quantity to, ready to use: `/v1/admin/stock-counts/{id}/items`.'),
});

export const scanResponse = z.object({
  matchedOn: z.enum(['barcode', 'sku']).describe('Which column resolved the scan.'),
  operation: z.enum(SCAN_OPERATIONS).describe('Echoed back, so a queued scan is self-describing.'),
  variantId: z.uuid().describe('Product variant id.'),
  sku: z.string().describe('Our SKU.'),
  name: z.string().nullable().describe('Product title plus option label.'),
  barcode: z.string().nullable().describe('The variant’s stored barcode.'),
  status: z.string().describe('Variant status. A scan of an archived variant still resolves — and says so.'),
  levels: z.array(scanLevel).describe('Stock positions, narrowed by `warehouseId` when one was given.'),
  activeCount: scanActiveCount
    .nullable()
    .describe(
      'Populated only when `operation` is `stock_count` and one of this variant’s levels is on an ' +
        '`in_progress` sheet. Null otherwise, including when a count exists but has not been started.',
    ),
  movesStock: z
    .literal(false)
    .describe('Always false. A scan resolves and returns context; the operation that moves stock is a separate call.'),
});

/* --------------------------------------------------------------------- QR */

export const qrResponse = z.object({
  sku: z.string().describe('Our SKU.'),
  barcode: z.string().nullable().describe('EAN-13, if the variant has one.'),
  name: z.string().nullable().describe('Product title plus option label — what a human reads off the label.'),
  optionLabel: z.string().describe('Variant option, e.g. `A5`.'),
  payload: z
    .string()
    .describe(
      'The exact string to encode in the QR symbol: `ACH1|<sku>|<barcode>`. Versioned so a scanner can ' +
        'recognise a label printed before a future format change.',
    ),
  version: z.literal('ACH1').describe('Payload format version.'),
  symbology: z.literal('QR').describe('Rendering the symbol is the client’s job; this endpoint returns the data.'),
  generatedAt: z.string().describe('ISO timestamp the payload was produced.'),
});

export type GenerateBarcodeBody = z.infer<typeof generateBarcodeBody>;
export type BulkGenerateBody = z.infer<typeof bulkGenerateBody>;
export type ScanBody = z.infer<typeof scanBody>;
export type BarcodeResponse = z.infer<typeof barcodeResponse>;
export type BarcodeGenerationResult = z.infer<typeof barcodeGenerationResult>;
export type BulkGenerationResult = z.infer<typeof bulkGenerationResult>;
export type ScanResponse = z.infer<typeof scanResponse>;
export type QrResponse = z.infer<typeof qrResponse>;
