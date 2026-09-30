import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { db } from '../../config/db.js';
import { invoices, invoiceLines, orders } from '../../db/schema/index.js';
import { NotFoundError } from '../../lib/errors.js';

export async function listInvoices(params: {
  page: number;
  perPage: number;
  status?: any;
  q?: string;
}) {
  const { page, perPage, status, q } = params;

  let conditions = [];
  if (status) conditions.push(eq(invoices.status, status));
  if (q) {
    conditions.push(
      or(ilike(invoices.invoiceNo, `%${q}%`), ilike(orders.orderNo, `%${q}%`))!,
    );
  }

  const offset = (page - 1) * perPage;

  const results = await db
    .select({
      id: invoices.id,
      invoiceNo: invoices.invoiceNo,
      orderNo: orders.orderNo,
      buyerName: invoices.buyerName,
      taxablePaise: invoices.taxablePaise,
      cgstPaise: invoices.cgstPaise,
      sgstPaise: invoices.sgstPaise,
      igstPaise: invoices.igstPaise,
      cessPaise: invoices.cessPaise,
      totalPaise: invoices.totalPaise,
      status: invoices.status,
      issuedAt: invoices.issuedAt,
    })
    .from(invoices)
    .leftJoin(orders, eq(invoices.orderId, orders.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(invoices.issuedAt))
    .limit(perPage)
    .offset(offset);

  const countResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(invoices)
    .leftJoin(orders, eq(invoices.orderId, orders.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  const count = countResult[0]?.count ?? 0;

  const items = results.map((r) => ({
    ...r,
    issuedAt: r.issuedAt.toISOString(),
  }));

  return {
    items,
    meta: {
      page,
      perPage,
      total: count,
      totalPages: Math.ceil(count / perPage),
    },
  };
}

export async function getInvoice(id: string) {
  const rows = await db
    .select({
      id: invoices.id,
      invoiceNo: invoices.invoiceNo,
      orderId: invoices.orderId,
      orderNo: orders.orderNo,
      buyerName: invoices.buyerName,
      buyerGstin: invoices.buyerGstin,
      buyerPhone: orders.buyerMobile,
      buyerEmail: orders.buyerEmail,
      buyerAddress: invoices.buyerAddress,
      shipLine1: orders.shipLine1,
      shipLine2: orders.shipLine2,
      shipCity: orders.shipCity,
      shipStateCode: orders.shipStateCode,
      shipPincode: orders.shipPincode,
      billLine1: orders.billLine1,
      billCity: orders.billCity,
      billStateCode: orders.billStateCode,
      billPincode: orders.billPincode,
      financialYear: invoices.financialYear,
      taxablePaise: invoices.taxablePaise,
      cgstPaise: invoices.cgstPaise,
      sgstPaise: invoices.sgstPaise,
      igstPaise: invoices.igstPaise,
      cessPaise: invoices.cessPaise,
      roundOffPaise: invoices.roundOffPaise,
      totalPaise: invoices.totalPaise,
      status: invoices.status,
      irn: invoices.irn,
      irnAckNo: invoices.irnAckNo,
      irnAckDate: invoices.irnAckDate,
      qrPayload: invoices.qrPayload,
      ewayBillNo: invoices.ewayBillNo,
      issuedAt: invoices.issuedAt,
    })
    .from(invoices)
    .leftJoin(orders, eq(invoices.orderId, orders.id))
    .where(eq(invoices.id, id));

  if (rows.length === 0) {
    throw new NotFoundError('Invoice not found');
  }

  const invoice = rows[0]!;

  const lines = await db
    .select({
      id: invoiceLines.id,
      description: invoiceLines.description,
      hsnCode: invoiceLines.hsnCode,
      quantity: invoiceLines.quantity,
      unit: invoiceLines.unit,
      unitPricePaise: invoiceLines.unitPricePaise,
      discountPaise: invoiceLines.discountPaise,
      taxablePaise: invoiceLines.taxablePaise,
      gstRateBp: invoiceLines.gstRateBp,
      cgstPaise: invoiceLines.cgstPaise,
      sgstPaise: invoiceLines.sgstPaise,
      igstPaise: invoiceLines.igstPaise,
      cessPaise: invoiceLines.cessPaise,
      lineTotalPaise: invoiceLines.lineTotalPaise,
    })
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, id))
    .orderBy(invoiceLines.position);

  const billingAddress = invoice.billLine1
    ? {
        line1: invoice.billLine1,
        city: invoice.billCity,
        stateCode: invoice.billStateCode,
        pincode: invoice.billPincode,
      }
    : {
        address: invoice.buyerAddress,
      };

  const shippingAddress = invoice.shipLine1
    ? {
        line1: invoice.shipLine1,
        line2: invoice.shipLine2,
        city: invoice.shipCity,
        stateCode: invoice.shipStateCode,
        pincode: invoice.shipPincode,
      }
    : null;

  return {
    ...invoice,
    billingAddress,
    shippingAddress,
    irnAckDate: invoice.irnAckDate ? invoice.irnAckDate.toISOString() : null,
    issuedAt: invoice.issuedAt.toISOString(),
    lines,
  };
}

export async function getBatchInvoices(ids: string[]) {
  if (ids.length === 0) return [];

  const rows = await db
    .select({
      id: invoices.id,
      invoiceNo: invoices.invoiceNo,
      orderId: invoices.orderId,
      orderNo: orders.orderNo,
      buyerName: invoices.buyerName,
      buyerGstin: invoices.buyerGstin,
      buyerPhone: orders.buyerMobile,
      buyerEmail: orders.buyerEmail,
      buyerAddress: invoices.buyerAddress,
      shipLine1: orders.shipLine1,
      shipLine2: orders.shipLine2,
      shipCity: orders.shipCity,
      shipStateCode: orders.shipStateCode,
      shipPincode: orders.shipPincode,
      billLine1: orders.billLine1,
      billCity: orders.billCity,
      billStateCode: orders.billStateCode,
      billPincode: orders.billPincode,
      financialYear: invoices.financialYear,
      taxablePaise: invoices.taxablePaise,
      cgstPaise: invoices.cgstPaise,
      sgstPaise: invoices.sgstPaise,
      igstPaise: invoices.igstPaise,
      cessPaise: invoices.cessPaise,
      roundOffPaise: invoices.roundOffPaise,
      totalPaise: invoices.totalPaise,
      status: invoices.status,
      irn: invoices.irn,
      irnAckNo: invoices.irnAckNo,
      irnAckDate: invoices.irnAckDate,
      qrPayload: invoices.qrPayload,
      ewayBillNo: invoices.ewayBillNo,
      issuedAt: invoices.issuedAt,
    })
    .from(invoices)
    .leftJoin(orders, eq(invoices.orderId, orders.id))
    .where(inArray(invoices.id, ids))
    .orderBy(desc(invoices.issuedAt));

  const allLines = await db
    .select({
      id: invoiceLines.id,
      invoiceId: invoiceLines.invoiceId,
      description: invoiceLines.description,
      hsnCode: invoiceLines.hsnCode,
      quantity: invoiceLines.quantity,
      unit: invoiceLines.unit,
      unitPricePaise: invoiceLines.unitPricePaise,
      discountPaise: invoiceLines.discountPaise,
      taxablePaise: invoiceLines.taxablePaise,
      gstRateBp: invoiceLines.gstRateBp,
      cgstPaise: invoiceLines.cgstPaise,
      sgstPaise: invoiceLines.sgstPaise,
      igstPaise: invoiceLines.igstPaise,
      cessPaise: invoiceLines.cessPaise,
      lineTotalPaise: invoiceLines.lineTotalPaise,
    })
    .from(invoiceLines)
    .where(inArray(invoiceLines.invoiceId, ids))
    .orderBy(invoiceLines.position);

  const linesByInvoice = new Map<string, typeof allLines>();
  for (const line of allLines) {
    const list = linesByInvoice.get(line.invoiceId) ?? [];
    list.push(line);
    linesByInvoice.set(line.invoiceId, list);
  }

  return rows.map((inv) => {
    const billingAddress = inv.billLine1
      ? {
          line1: inv.billLine1,
          city: inv.billCity,
          stateCode: inv.billStateCode,
          pincode: inv.billPincode,
        }
      : {
          address: inv.buyerAddress,
        };

    const shippingAddress = inv.shipLine1
      ? {
          line1: inv.shipLine1,
          line2: inv.shipLine2,
          city: inv.shipCity,
          stateCode: inv.shipStateCode,
          pincode: inv.shipPincode,
        }
      : null;

    return {
      ...inv,
      billingAddress,
      shippingAddress,
      irnAckDate: inv.irnAckDate ? inv.irnAckDate.toISOString() : null,
      issuedAt: inv.issuedAt.toISOString(),
      lines: linesByInvoice.get(inv.id) ?? [],
    };
  });
}
