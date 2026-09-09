/**
 * Derived fields for the corporate leads list and detail view.
 * Extracts image/attachment references from brief and normalizes fields.
 */

type Row = Record<string, unknown>;

const ATTACHMENT_PATTERN = /\[Attachment\]:\s*(\S+)/i;

export async function enrichLeads(rows: Row[]): Promise<Row[]> {
  if (rows.length === 0) return rows;

  return rows.map((row) => {
    const enriched = { ...row };
    const brief = typeof row.brief === 'string' ? row.brief : '';

    const match = brief.match(ATTACHMENT_PATTERN);
    const attachmentUrl = match?.[1] || (row.imageUrl as string | undefined) || (row.attachmentUrl as string | undefined) || null;

    if (attachmentUrl) {
      enriched.imageUrl = attachmentUrl;
      enriched.attachmentUrl = attachmentUrl;
      enriched.image = attachmentUrl;
    }

    return enriched;
  });
}
