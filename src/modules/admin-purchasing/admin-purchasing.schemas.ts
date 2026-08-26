/**
 * Purchasing contracts — supplier catalogues, purchase orders, goods receipts
 * and purchase returns.
 *
 * Money is integer paise everywhere, and every total is recomputed server-side
 * from the lines. A client-supplied `totalPaise` is not trusted here for the
 * same reason it is not trusted on an order: it is the one number worth lying
 * about.
 */

import { z } from 'zod';
import { listQuery } from '../../lib/pagination.js';
import {
  GRN_QC_STATUSES,
  PURCHASE_ORDER_STATUSES,
  PURCHASE_RETURN_REASONS,
  PURCHASE_RETURN_STATUSES,
} from '../../db/schema/index.js';
import { PO_LIFECYCLES } from './admin-purchasing.state.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isoDate = (what: string) =>
  z.string().regex(ISO_DATE, 'Use YYYY-MM-DD.').describe(`\`YYYY-MM-DD\`. ${what}`);

const paise = (what: string) =>
  z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).describe(`Integer paise. ${what}`);

/* ------------------------------------------------------------ path params */

export const supplierIdParam = z.object({
  supplierId: z.uuid().describe('Supplier id.'),
});

export const supplierProductParams = z.object({
  supplierId: z.uuid().describe('Supplier id. The catalogue entry must belong to it.'),
  supplierProductId: z.uuid().describe('Supplier catalogue entry id.'),
});

export const poIdParam = z.object({ poId: z.uuid().describe('Purchase order id.') });
export const grnIdParam = z.object({ grnId: z.uuid().describe('Goods receipt id.') });
export const returnIdParam = z.object({ returnId: z.uuid().describe('Purchase return id.') });

/* ======================================================= supplier products */

const stockableTarget = {
  variantId: z.uuid().optional().describe('Product variant this supplier sells. Exactly one target.'),
  hamperItemId: z.uuid().optional().describe('Loose hamper item this supplier sells. Exactly one target.'),
  packagingId: z.uuid().optional().describe('Packaging material this supplier sells. Exactly one target.'),
};

const exactlyOneTarget = (v: { variantId?: string; hamperItemId?: string; packagingId?: string }): boolean =>
  [v.variantId, v.hamperItemId, v.packagingId].filter(Boolean).length === 1;

export const supplierProductListQuery = listQuery.extend({
  preferredOnly: z
    .enum(['true', 'false'])
    .optional()
    .describe('`true` returns only the entries marked preferred for their target.'),
  includeArchived: z.enum(['true', 'false']).default('false').describe('Include soft-deleted entries.'),
  sort: z.string().max(120).optional().describe('`sku` (default), `unitCostPaise`, `leadTimeDays`, `moq`, `createdAt`.'),
});

export const createSupplierProductBody = z
  .object({
    ...stockableTarget,
    supplierSku: z
      .string()
      .trim()
      .max(80)
      .nullish()
      .describe('What the SUPPLIER calls it. This is what goes on the PO they receive.'),
    unitCostPaise: paise('What they charge per unit, excluding GST.').default(0),
    moq: z
      .number()
      .int()
      .min(1)
      .max(1_000_000)
      .default(1)
      .describe('Minimum order quantity. The reorder engine rounds suggestions up to this.'),
    leadTimeDays: z
      .number()
      .int()
      .min(0)
      .max(3_650)
      .default(0)
      .describe('Days from order to delivery. Feeds reorder point = daily consumption × lead time + safety.'),
    isPreferred: z
      .boolean()
      .default(false)
      .describe(
        'At most ONE preferred supplier per variant, enforced by a partial unique index. Setting this ' +
          'clears the flag on whoever held it, in the same transaction.',
      ),
  })
  .refine(exactlyOneTarget, {
    message: 'Give exactly one of `variantId`, `hamperItemId` or `packagingId` — the CHECK refuses anything else.',
    path: ['variantId'],
  });

export const updateSupplierProductBody = z
  .object({
    supplierSku: z.string().trim().max(80).nullish().describe('Supplier’s own SKU, or null to clear.'),
    unitCostPaise: paise('New unit cost.').optional(),
    moq: z.number().int().min(1).max(1_000_000).optional().describe('Minimum order quantity.'),
    leadTimeDays: z.number().int().min(0).max(3_650).optional().describe('Lead time in days.'),
    isPreferred: z.boolean().optional().describe('Promote or demote. Promotion demotes the incumbent.'),
    archived: z
      .boolean()
      .optional()
      .describe('True soft-deletes the entry, freeing its slot in the unique index. False restores it.'),
  })
  .describe('Every field optional. The target (variant/hamper item/packaging) is immutable — create a new entry instead.');

export const supplierProductResponse = z.object({
  id: z.uuid().describe('Supplier catalogue entry id.'),
  supplierId: z.uuid().describe('Supplier.'),
  targetKind: z.enum(['variant', 'hamper_item', 'packaging']).describe('Which stockable kind this entry prices.'),
  targetId: z.uuid().describe('Id of the variant, hamper item or packaging material.'),
  sku: z.string().nullable().describe('Our SKU for the target.'),
  title: z.string().nullable().describe('Display name of the target.'),
  supplierSku: z.string().nullable().describe('The supplier’s own code for it.'),
  unitCostPaise: z.number().int().describe('Integer paise, excluding GST.'),
  currency: z.string().describe('Always `INR`.'),
  moq: z.number().int().describe('Minimum order quantity.'),
  leadTimeDays: z.number().int().describe('Days from order to delivery.'),
  isPreferred: z.boolean().describe('Whether this is the default source for the target.'),
  lastPurchaseAt: z.string().nullable().describe('ISO timestamp of the last PO that included it.'),
  lastPurchaseCostPaise: z.number().int().nullable().describe('What we actually last paid, in paise.'),
  archivedAt: z.string().nullable().describe('ISO timestamp when soft-deleted, or null.'),
  createdAt: z.string().describe('ISO timestamp.'),
});

/* ========================================================= purchase orders */

export const poStatus = z
  .enum(PURCHASE_ORDER_STATUSES)
  .describe('The stored status. Five values, fixed by the database CHECK.');

export const poLifecycleSchema = z
  .enum(PO_LIFECYCLES)
  .describe(
    'What the stored status MEANS, derived from `status` + `sentAt`. `sent` with no `sentAt` is ' +
      '`approved` — approved but not yet in front of the supplier, and the state where `incomingQty` ' +
      'has deliberately not been raised.',
  );

export const poListQuery = listQuery.extend({
  status: z.string().max(200).optional().describe('One stored status or a comma-separated list.'),
  supplierId: z.uuid().optional().describe('Restrict to one supplier.'),
  warehouseId: z.uuid().optional().describe('Restrict to one receiving warehouse.'),
  expectedFrom: isoDate('Inclusive lower bound on `expectedOn`.').optional(),
  expectedTo: isoDate('Inclusive upper bound on `expectedOn`.').optional(),
  sort: z.string().max(120).optional().describe('`-createdAt` (default), `createdAt`, `poNo`, `status`, `expectedOn`, `totalPaise`.'),
});

export const poLineInput = z
  .object({
    ...stockableTarget,
    description: z
      .string()
      .trim()
      .min(1)
      .max(400)
      .describe('What the supplier sees on the line. Frozen — the catalogue moves on, the PO does not.'),
    orderedQty: z.number().int().positive().max(1_000_000).describe('Units ordered. Must be positive.'),
    unitCostPaise: paise('Agreed unit cost, excluding GST.'),
    gstRateBp: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .default(0)
      .describe('GST rate in basis points. 1800 = 18%. Tax is computed from this, never sent by the client.'),
  })
  .refine(exactlyOneTarget, {
    message: 'Give exactly one of `variantId`, `hamperItemId` or `packagingId`.',
    path: ['variantId'],
  });

export const createPoBody = z.object({
  supplierId: z.uuid().describe('Who we are buying from.'),
  warehouseId: z.uuid().describe('Where the goods will be received. The GRN must name the same warehouse.'),
  expectedOn: isoDate('When the goods are expected.').nullish(),
  notes: z.string().trim().max(2_000).nullish().describe('Internal notes. Not sent to the supplier by this API.'),
  lines: z.array(poLineInput).min(1).max(500).describe('At least one line. A PO for nothing is not a document.'),
});

export const updatePoBody = z.object({
  expectedOn: isoDate('When the goods are expected, or null to clear.').nullish(),
  notes: z.string().trim().max(2_000).nullish().describe('Internal notes, or null to clear.'),
  lines: z
    .array(poLineInput)
    .min(1)
    .max(500)
    .optional()
    .describe('Replaces ALL lines when given. Totals are recomputed. Draft only.'),
});

export const cancelPoBody = z.object({
  reason: z.string().trim().min(3).max(400).describe('Why. Appended to the PO notes and the audit log.'),
});

export const poLineResponse = z.object({
  id: z.uuid().describe('PO line id. Goods-receipt lines reference this.'),
  targetKind: z.enum(['variant', 'hamper_item', 'packaging']).describe('Which stockable kind the line orders.'),
  targetId: z.uuid().describe('Id of the variant, hamper item or packaging material.'),
  sku: z.string().nullable().describe('Our SKU for the target.'),
  description: z.string().describe('Frozen description, as it went to the supplier.'),
  orderedQty: z.number().int().describe('Units ordered.'),
  receivedQty: z
    .number()
    .int()
    .describe('Units ACCEPTED so far. Rejected units are recorded on the GRN and never counted here.'),
  outstandingQty: z.number().int().describe('`orderedQty - receivedQty`. Zero closes the line.'),
  unitCostPaise: z.number().int().describe('Integer paise, excluding GST.'),
  gstRateBp: z.number().int().describe('GST rate in basis points. 1800 = 18%.'),
  lineTotalPaise: z.number().int().describe('`orderedQty × unitCostPaise`, excluding GST. Server-computed.'),
});

export const poSummary = z.object({
  id: z.uuid().describe('Purchase order id.'),
  poNo: z.string().describe('`PO-2026-02291`, from the document-number series.'),
  status: poStatus,
  lifecycle: poLifecycleSchema,
  supplierId: z.uuid().describe('Supplier.'),
  supplierName: z.string().nullable().describe('Supplier name.'),
  warehouseId: z.uuid().describe('Receiving warehouse.'),
  warehouseName: z.string().nullable().describe('Receiving warehouse name.'),
  currency: z.string().describe('Always `INR`.'),
  subtotalPaise: z.number().int().describe('Sum of line totals, excluding GST. Integer paise.'),
  taxPaise: z.number().int().describe('Sum of per-line GST, from each line’s basis-point rate.'),
  totalPaise: z.number().int().describe('`subtotal + tax`. Integer paise.'),
  lineCount: z.number().int().describe('Number of lines.'),
  orderedQty: z.number().int().describe('Total units ordered across lines.'),
  receivedQty: z.number().int().describe('Total units accepted across lines.'),
  expectedOn: z.string().nullable().describe('`YYYY-MM-DD`, or null.'),
  sentAt: z.string().nullable().describe('ISO timestamp when sent to the supplier. Null while merely approved.'),
  closedAt: z.string().nullable().describe('ISO timestamp when fully received or cancelled.'),
  createdAt: z.string().describe('ISO timestamp.'),
});

export const availablePoAction = z.object({
  action: z.enum(['edit', 'approve', 'send', 'receive', 'cancel']).describe('The endpoint this edge corresponds to.'),
  to: poLifecycleSchema.describe('The lifecycle the PO lands in.'),
  label: z.string().describe('Human label for the button.'),
  documentDriven: z
    .boolean()
    .describe('True when a goods receipt drives it. No endpoint sets these by hand; render them disabled.'),
  sideEffects: z.array(z.string()).describe('What else happens.'),
});

export const poDetail = poSummary.extend({
  notes: z.string().nullable().describe('Internal notes.'),
  createdBy: z.uuid().nullable().describe('Staff member who raised it.'),
  lines: z.array(poLineResponse).describe('The lines.'),
  receipts: z
    .array(
      z.object({
        id: z.uuid().describe('Goods receipt id.'),
        grnNo: z.string().describe('`GRN-2026-00912`.'),
        receivedOn: z.string().describe('`YYYY-MM-DD`.'),
        qcStatus: z.enum(GRN_QC_STATUSES).describe('Inspection outcome for the receipt as a whole.'),
        acceptedQty: z.number().int().describe('Units accepted into stock by this receipt.'),
        rejectedQty: z.number().int().describe('Units rejected. Never entered stock.'),
      }),
    )
    .describe('Every goods receipt posted against this PO, newest first.'),
  availableActions: z.array(availablePoAction).describe('Legal edges from the current lifecycle.'),
});

/* ========================================================== goods receipts */

export const grnListQuery = listQuery.extend({
  purchaseOrderId: z.uuid().optional().describe('Restrict to one purchase order.'),
  warehouseId: z.uuid().optional().describe('Restrict to one warehouse.'),
  qcStatus: z.enum(GRN_QC_STATUSES).optional().describe('`passed`, `partial` or `failed`.'),
  receivedFrom: isoDate('Inclusive lower bound on `receivedOn`.').optional(),
  receivedTo: isoDate('Inclusive upper bound on `receivedOn`.').optional(),
  sort: z.string().max(120).optional().describe('`-receivedOn` (default), `receivedOn`, `grnNo`, `createdAt`.'),
});

export const createGrnBody = z.object({
  purchaseOrderId: z.uuid().describe('The PO being received against. Must be sent or partially received.'),
  receivedOn: isoDate('When the goods physically arrived. Defaults to today.').optional(),
  qcStatus: z
    .enum(GRN_QC_STATUSES)
    .default('passed')
    .describe('Inspection outcome for the receipt as a whole. Per-line rejections are on the lines.'),
  inspectorId: z.uuid().nullish().describe('Staff member who inspected the goods.'),
  supplierInvoiceNo: z.string().trim().max(60).nullish().describe('The supplier’s invoice number, for reconciliation.'),
  notes: z.string().trim().max(2_000).nullish().describe('Free text.'),
  lines: z
    .array(
      z
        .object({
          poLineId: z.uuid().describe('Which PO line this receipt line is against.'),
          acceptedQty: z
            .number()
            .int()
            .min(0)
            .max(1_000_000)
            .describe('Units that passed inspection. These are the ones added to on-hand.'),
          rejectedQty: z
            .number()
            .int()
            .min(0)
            .max(1_000_000)
            .default(0)
            .describe(
              'Units that failed inspection. Recorded here and NEVER added to stock — damaged goods that ' +
                'entered on-hand would be sellable. Raise a purchase return to send them back.',
            ),
          rejectionReason: z
            .string()
            .trim()
            .max(400)
            .nullish()
            .describe('Required whenever `rejectedQty` is above zero. The database CHECKs it too.'),
          batchNo: z.string().trim().max(60).nullish().describe('Supplier batch or lot number.'),
          expiryOn: isoDate('Expiry date, for perishables.').nullish(),
        })
        .refine((line) => line.acceptedQty + line.rejectedQty > 0, {
          message: 'A receipt line must account for at least one unit — accepted, rejected, or both.',
          path: ['acceptedQty'],
        })
        .refine((line) => line.rejectedQty === 0 || Boolean(line.rejectionReason), {
          message: '`rejectionReason` is required when anything is rejected.',
          path: ['rejectionReason'],
        }),
    )
    .min(1)
    .max(500)
    .describe('At least one line. Partial receipts are normal — the PO stays `partially_received`.'),
});

export const grnLineResponse = z.object({
  id: z.uuid().describe('Goods receipt line id.'),
  poLineId: z.uuid().describe('The PO line received against.'),
  sku: z.string().nullable().describe('Our SKU for the stockable.'),
  description: z.string().nullable().describe('The PO line description.'),
  acceptedQty: z.number().int().describe('Units added to on-hand.'),
  rejectedQty: z.number().int().describe('Units rejected. Tracked separately; never entered stock.'),
  rejectionReason: z.string().nullable().describe('Why they were rejected.'),
  batchNo: z.string().nullable().describe('Supplier batch or lot number.'),
  expiryOn: z.string().nullable().describe('`YYYY-MM-DD`, or null.'),
});

export const grnSummary = z.object({
  id: z.uuid().describe('Goods receipt id.'),
  grnNo: z.string().describe('`GRN-2026-00912`, from the document-number series.'),
  purchaseOrderId: z.uuid().describe('The PO received against.'),
  poNo: z.string().nullable().describe('That PO’s number.'),
  warehouseId: z.uuid().describe('Where the goods landed.'),
  warehouseName: z.string().nullable().describe('Warehouse name.'),
  supplierId: z.uuid().nullable().describe('Supplier, from the PO.'),
  supplierName: z.string().nullable().describe('Supplier name.'),
  receivedOn: z.string().describe('`YYYY-MM-DD`.'),
  qcStatus: z.enum(GRN_QC_STATUSES).describe('Inspection outcome for the receipt.'),
  supplierInvoiceNo: z.string().nullable().describe('Supplier’s invoice number.'),
  acceptedQty: z.number().int().describe('Total units accepted into stock.'),
  rejectedQty: z.number().int().describe('Total units rejected.'),
  lineCount: z.number().int().describe('Number of lines.'),
  createdAt: z.string().describe('ISO timestamp.'),
});

export const grnDetail = grnSummary.extend({
  inspectorId: z.uuid().nullable().describe('Who inspected.'),
  notes: z.string().nullable().describe('Free text.'),
  poStatusAfter: poStatus.describe('What the PO’s stored status became once this receipt was posted.'),
  lines: z.array(grnLineResponse).describe('The lines.'),
});

/* ========================================================= purchase returns */

export const returnStatus = z
  .enum(PURCHASE_RETURN_STATUSES)
  .describe('All six spec statuses exist in the database for returns — no derivation needed.');

export const returnReason = z
  .enum(PURCHASE_RETURN_REASONS)
  .describe('Why the goods are going back. Fixed vocabulary, enforced by a CHECK.');

export const returnListQuery = listQuery.extend({
  status: z.string().max(200).optional().describe('One status or a comma-separated list.'),
  supplierId: z.uuid().optional().describe('Restrict to one supplier.'),
  warehouseId: z.uuid().optional().describe('Restrict to one warehouse.'),
  reason: z.enum(PURCHASE_RETURN_REASONS).optional().describe('Restrict to one reason.'),
  sort: z.string().max(120).optional().describe('`-createdAt` (default), `createdAt`, `returnNo`, `status`, `totalPaise`.'),
});

export const createReturnBody = z.object({
  supplierId: z.uuid().describe('Who the goods are going back to.'),
  warehouseId: z.uuid().describe('Where they are leaving from. Every line’s level must be in this warehouse.'),
  goodsReceiptId: z.uuid().nullish().describe('The receipt being returned against, when it is known.'),
  reason: returnReason,
  note: z.string().trim().max(2_000).nullish().describe('Free text.'),
  taxPaise: paise('GST to reverse, if any. Zero when the goods were never taxed to us.').default(0),
  lines: z
    .array(
      z.object({
        inventoryLevelId: z
          .uuid()
          .describe(
            'The exact level the stock leaves. Get it from ' +
              '`GET /v1/admin/warehouses/{warehouseId}/inventory` — returns name a level, not a SKU, so ' +
              'there is no ambiguity about which warehouse gives the stock up.',
          ),
        quantity: z.number().int().positive().max(1_000_000).describe('Units to send back.'),
        unitCostPaise: paise('What we paid per unit. Drives the credit expected from the supplier.').default(0),
        note: z.string().trim().max(400).nullish().describe('Per-line note.'),
      }),
    )
    .min(1)
    .max(500)
    .describe('At least one line.'),
});

export const returnLineResponse = z.object({
  id: z.uuid().describe('Return line id.'),
  inventoryLevelId: z.uuid().describe('The level the stock leaves.'),
  sku: z.string().nullable().describe('Our SKU for the stockable.'),
  title: z.string().nullable().describe('Display name of the stockable.'),
  quantity: z.number().int().describe('Units going back.'),
  unitCostPaise: z.number().int().describe('Integer paise.'),
  lineTotalPaise: z.number().int().describe('`quantity × unitCostPaise`. Server-computed.'),
  note: z.string().nullable().describe('Per-line note.'),
});

export const availableReturnAction = z.object({
  action: z.enum(['approve', 'dispatch', 'complete', 'cancel']).describe('The endpoint this edge corresponds to.'),
  to: returnStatus.describe('The status the return lands in.'),
  label: z.string().describe('Human label for the button.'),
  movesStock: z.boolean().describe('True when taking this edge writes to the ledger.'),
  sideEffects: z.array(z.string()).describe('What else happens.'),
});

export const returnSummary = z.object({
  id: z.uuid().describe('Purchase return id.'),
  returnNo: z.string().describe('`PRET-2026-00001`, from the document-number series.'),
  status: returnStatus,
  reason: returnReason,
  supplierId: z.uuid().describe('Supplier.'),
  supplierName: z.string().nullable().describe('Supplier name.'),
  warehouseId: z.uuid().describe('Warehouse the stock leaves.'),
  warehouseName: z.string().nullable().describe('Warehouse name.'),
  goodsReceiptId: z.uuid().nullable().describe('The receipt being returned against, if any.'),
  subtotalPaise: z.number().int().describe('Sum of line totals. Integer paise.'),
  taxPaise: z.number().int().describe('GST being reversed. Integer paise.'),
  totalPaise: z.number().int().describe('`subtotal + tax`. The credit expected from the supplier.'),
  lineCount: z.number().int().describe('Number of lines.'),
  totalQty: z.number().int().describe('Total units going back.'),
  approvedAt: z.string().nullable().describe('ISO timestamp, or null.'),
  dispatchedAt: z.string().nullable().describe('ISO timestamp when the stock left, or null.'),
  createdAt: z.string().describe('ISO timestamp.'),
});

export const returnDetail = returnSummary.extend({
  note: z.string().nullable().describe('Free text.'),
  createdBy: z.uuid().nullable().describe('Staff member who raised it.'),
  approvedBy: z.uuid().nullable().describe('Staff member who approved it.'),
  lines: z.array(returnLineResponse).describe('The lines.'),
  availableActions: z.array(availableReturnAction).describe('Legal edges from the current status.'),
});

export type SupplierProductResponse = z.infer<typeof supplierProductResponse>;
export type PoSummaryResponse = z.infer<typeof poSummary>;
export type PoDetailResponse = z.infer<typeof poDetail>;
export type GrnSummaryResponse = z.infer<typeof grnSummary>;
export type GrnDetailResponse = z.infer<typeof grnDetail>;
export type ReturnSummaryResponse = z.infer<typeof returnSummary>;
export type ReturnDetailResponse = z.infer<typeof returnDetail>;
