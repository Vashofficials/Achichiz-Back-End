import * as repo from './admin-reports.repository.js';
import type { z } from 'zod';
import type {
  agingQuery,
  valuationQuery,
  movementReportQuery,
  performanceQuery,
  velocityQuery,
} from './admin-reports.schemas.js';
import { BadRequestError } from '../../lib/errors.js';

export async function getInventoryAging(query: z.infer<typeof agingQuery>) {
  return await repo.getInventoryAging(query);
}

export async function getDeadStock(query: z.infer<typeof agingQuery>) {
  return await repo.getDeadStock(query);
}

export async function getInventoryValuation(query: z.infer<typeof valuationQuery>) {
  return await repo.getInventoryValuation(query);
}

export async function getStockMovementsReport(query: z.infer<typeof movementReportQuery>) {
  return await repo.getStockMovementsReport(query);
}

export async function getProductPerformance(query: z.infer<typeof performanceQuery>) {
  return await repo.getProductPerformance(query);
}

export async function getSupplierPerformance(query: z.infer<typeof performanceQuery>) {
  return await repo.getSupplierPerformance(query);
}

export async function getInventoryHealth() {
  return await repo.getInventoryHealth();
}

export async function getStockVelocity(query: z.infer<typeof velocityQuery>) {
  // Spec §74 says when history is insufficient, return INSUFFICIENT_DATA.
  // Actually, we don't throw, the repository just returns unitsPerDay: 0 if there are no movements.
  return await repo.getStockVelocity(query);
}

export async function getPurchaseForecast(query: z.infer<typeof velocityQuery>) {
  return await repo.getPurchaseForecast(query);
}

/**
 * Characters that make a spreadsheet treat a cell as a FORMULA rather than text.
 *
 * Export rows carry operator- and supplier-supplied strings — SKUs, product
 * titles, movement notes. A note beginning `=HYPERLINK(...)` executes when the
 * file is opened in Excel or Sheets. Prefixing with a tab neutralises it while
 * leaving the visible text unchanged; it is the standard mitigation and it costs
 * nothing on a value that was never a formula.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * RFC 4180 quoting.
 *
 * Quotes on comma, double-quote AND newline. Newline is the one the obvious
 * implementation forgets: an unquoted value containing `\n` silently splits one
 * record into two, and every row after it in the file is shifted by a column.
 */
function csvCell(value: repo.ReportRow[string] | undefined): string {
  if (value === null || value === undefined) return '';

  const raw = value instanceof Date ? value.toISOString() : String(value);
  const guarded = FORMULA_LEAD.test(raw) ? `\t${raw}` : raw;

  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export async function exportReportData(report: string, query: repo.ExportQuery): Promise<string> {
  if (!(repo.EXPORTABLE_REPORTS as readonly string[]).includes(report)) {
    throw new BadRequestError(
      `\`${report}\` cannot be exported. Available: ${repo.EXPORTABLE_REPORTS.join(', ')}.`,
    );
  }

  const data = await repo.exportReportData(report as repo.ExportableReport, query);
  if (data.length === 0) return '';

  // Column order comes from the first row and is applied to every row, so a row
  // missing a key produces an empty cell rather than a shifted record.
  const keys = Object.keys(data[0] ?? {});
  const header = keys.map(csvCell).join(',');
  const rows = data.map((row) => keys.map((k) => csvCell(row[k])).join(','));

  // CRLF per RFC 4180 — Excel on Windows treats a bare LF file as one long row.
  return [header, ...rows].join('\r\n');
}
