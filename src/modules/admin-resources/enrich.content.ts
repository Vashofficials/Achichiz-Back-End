/**
 * Derived fields for content lists (homepage-cms, occasions, seo).
 */

import { inArray, count } from 'drizzle-orm';
import { db } from '../../config/db.js';
import { cmsSectionItems } from '../../db/schema/index.js';

type Row = Record<string, unknown>;

export async function enrichHomepageCms(rows: Row[]): Promise<Row[]> {
  if (rows.length === 0) return rows;

  const sectionIds = [...new Set(rows.map((r) => r.id).filter((v): v is string => typeof v === 'string'))];

  const itemCounts = sectionIds.length
    ? await db
        .select({
          sectionId: cmsSectionItems.sectionId,
          items: count(),
        })
        .from(cmsSectionItems)
        .where(inArray(cmsSectionItems.sectionId, sectionIds))
        .groupBy(cmsSectionItems.sectionId)
    : [];

  const map = new Map(itemCounts.map((s) => [s.sectionId, Number(s.items || 0)]));

  return rows.map((row) => ({
    ...row,
    items: typeof row.id === 'string' ? (map.get(row.id) || 0) : 0,
  }));
}

export async function enrichOccasionPages(rows: Row[]): Promise<Row[]> {
  if (rows.length === 0) return rows;

  return rows.map((row) => ({
    ...row,
    // Counting actual products would require joining through the collectionId.
    // For now, mock the metrics that the frontend requests:
    products: 0,
    traffic: 0,
    conversion: 0,
    seoScore: 0,
  }));
}

export async function enrichSeoEntries(rows: Row[]): Promise<Row[]> {
  if (rows.length === 0) return rows;

  return rows.map((row) => ({
    ...row,
    metaLength: typeof row.metaDescription === 'string' ? row.metaDescription.length : 0,
    score: 0, // Requires integration with an SEO tool or analyzer
  }));
}

export async function enrichBlogs(rows: Row[]): Promise<Row[]> {
  if (rows.length === 0) return rows;
  return rows.map((row) => ({
    ...row,
    views: 0, // Mock view count until web analytics integration
  }));
}

export async function enrichMenus(rows: Row[]): Promise<Row[]> {
  if (rows.length === 0) return rows;
  return rows.map((row) => ({
    ...row,
    children: 0, // Would require joining with menu_items in production
  }));
}

export async function enrichMediaLibrary(rows: Row[]): Promise<Row[]> {
  if (rows.length === 0) return rows;
  return rows.map((row) => ({
    ...row,
    usedIn: 0, // Would require checking usage across all content tables
  }));
}
