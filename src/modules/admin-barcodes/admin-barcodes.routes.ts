import { Router } from 'express';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { ok } from '../../lib/http.js';
import * as barcodes from './admin-barcodes.service.js';
import {
  barcodeGenerationResult,
  barcodeResponse,
  bulkGenerateBody,
  bulkGenerationResult,
  generateBarcodeBody,
  qrResponse,
  scanBody,
  scanResponse,
  skuParam,
} from './admin-barcodes.schemas.js';

/**
 * Barcode and QR.
 *
 * Thinner than it looks, because `product_variants.barcode` already existed —
 * there is no registry table and none is needed until a SKU needs more than one
 * barcode or a scan history has to be kept.
 *
 * The important boundary is what a scan DOES: it resolves a barcode to a variant
 * and returns the context that operation needs. It does not move stock. Every
 * stock movement in this system goes through an endpoint that names the movement
 * — a scanner that silently decremented would be an unauditable side door.
 */
export const adminBarcodesRouter: Router = Router();

const TAG = 'Admin barcodes';

defineRoute(adminBarcodesRouter, {
  method: 'get',
  path: '/v1/admin/barcodes/:sku',
  surface: 'admin',
  operationId: 'adminGetBarcode',
  summary: 'Get the barcode for a SKU',
  description:
    'Returns the stored EAN-13 for a variant, with a validity check on the check digit. A SKU with ' +
    'no barcode yet is a 200 with `barcode: null`, not a 404 — the variant exists, it simply has ' +
    'not been labelled.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { params: skuParam },
  responses: {
    200: { description: 'Barcode state for the SKU.', schema: barcodeResponse },
    404: { description: 'No variant with that SKU.' },
  },
  handler: async ({ params }) => ok(await barcodes.getBySku(params.sku)),
});

defineRoute(adminBarcodesRouter, {
  method: 'post',
  path: '/v1/admin/barcodes/generate',
  surface: 'admin',
  operationId: 'adminGenerateBarcode',
  summary: 'Generate a barcode for one SKU',
  description:
    'Mints an EAN-13 in an internal (restricted-circulation) prefix range and stores it on the ' +
    'variant. Refuses to overwrite an existing barcode unless `force` is set: a relabelled SKU ' +
    'orphans every carton already printed with the old code.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'edit' },
  idempotent: true,
  request: { body: generateBarcodeBody },
  responses: {
    200: { description: 'The barcode assigned.', schema: barcodeGenerationResult },
    404: { description: 'No variant with that SKU.' },
    422: { description: 'The SKU already has a barcode and `force` was not set.' },
  },
  handler: async ({ body }) => ok(await barcodes.generate(body)),
});

defineRoute(adminBarcodesRouter, {
  method: 'post',
  path: '/v1/admin/barcodes/bulk-generate',
  surface: 'admin',
  operationId: 'adminBulkGenerateBarcodes',
  summary: 'Generate barcodes for many SKUs',
  description:
    'All-or-nothing in one transaction. Codes are minted distinct from each other AND from every ' +
    'barcode already stored — a duplicate EAN-13 across two SKUs makes the scanner ambiguous, which ' +
    'is worse than having no barcode at all.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'edit' },
  idempotent: true,
  request: { body: bulkGenerateBody },
  responses: {
    200: { description: 'What was assigned and what was skipped.', schema: bulkGenerationResult },
    422: { description: 'A SKU is unknown, or already had a barcode and `force` was not set.' },
  },
  handler: async ({ body }) => ok(await barcodes.bulkGenerate(body)),
});

defineRoute(adminBarcodesRouter, {
  method: 'post',
  path: '/v1/admin/barcodes/scan',
  surface: 'admin',
  operationId: 'adminScanBarcode',
  summary: 'Resolve a scanned barcode',
  description:
    'Resolves a barcode to its variant and returns the context the named operation needs — stock ' +
    'levels per warehouse, and the active stock count when the operation is `stock_count`.\n\n' +
    '**This endpoint does not move stock.** It answers "what am I holding, and what can I do with ' +
    'it here"; the actual movement goes through the endpoint that names it (adjustment, receipt, ' +
    'transfer, count item). A scanner that silently decremented would be an unauditable side door ' +
    'into the ledger.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'edit' },
  request: { body: scanBody },
  responses: {
    200: { description: 'The resolved variant and its operation context.', schema: scanResponse },
    404: { description: 'No variant carries that barcode.' },
  },
  handler: async ({ body }) => ok(await barcodes.scan(body)),
});

defineRoute(adminBarcodesRouter, {
  method: 'get',
  path: '/v1/admin/qr/:sku',
  surface: 'admin',
  operationId: 'adminGetSkuQr',
  summary: 'Get the QR payload for a SKU',
  description:
    'Returns a payload safe to print on a label: SKU, title, barcode and a version marker. It ' +
    'deliberately carries **no cost, no supplier and no warehouse quantities** — a QR on a carton ' +
    'is readable by anyone in the supply chain, including people who should not learn your margins.',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'inventory', action: 'view' },
  request: { params: skuParam },
  responses: {
    200: { description: 'Label-safe QR payload.', schema: qrResponse },
    404: { description: 'No variant with that SKU.' },
  },
  handler: async ({ params }) => ok(await barcodes.getQr(params.sku)),
});
