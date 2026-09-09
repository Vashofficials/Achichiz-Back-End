import { sql } from 'drizzle-orm';
import { db } from '../../config/db.js';
import { CANONICAL_POLICIES } from '../../modules/content/policies.data.js';

export async function seedPolicies(): Promise<{ upserted: number }> {
  let count = 0;

  for (const policy of Object.values(CANONICAL_POLICIES)) {
    const bodyJson = JSON.stringify(policy.body);

    await db.execute(sql`
      INSERT INTO content_pages (
        id,
        slug,
        kind,
        title,
        heading,
        body_blocks,
        status,
        published_at,
        created_at,
        updated_at
      )
      VALUES (
        ${policy.id}::uuid,
        ${policy.slug},
        'policy',
        ${policy.title},
        ${policy.heading},
        ${bodyJson}::jsonb,
        'published',
        ${policy.publishedAt ? new Date(policy.publishedAt) : new Date()},
        now(),
        now()
      )
      ON CONFLICT (slug) WHERE deleted_at IS NULL DO UPDATE
        SET title = EXCLUDED.title,
            heading = EXCLUDED.heading,
            body_blocks = EXCLUDED.body_blocks,
            status = 'published',
            updated_at = now()
    `);

    if (policy.seo) {
      await db.execute(sql`
        INSERT INTO seo_entries (
          entity_type,
          entity_id,
          route_path,
          meta_title,
          meta_description,
          canonical_url,
          focus_keyword,
          robots_index,
          robots_follow,
          created_at,
          updated_at
        )
        VALUES (
          'content_page',
          ${policy.id}::uuid,
          ${'/policies/' + policy.slug},
          ${policy.seo.metaTitle},
          ${policy.seo.metaDescription},
          ${policy.seo.canonicalUrl},
          ${policy.seo.focusKeyword},
          ${policy.seo.robotsIndex},
          ${policy.seo.robotsFollow},
          now(),
          now()
        )
        ON CONFLICT (route_path) WHERE deleted_at IS NULL DO UPDATE
          SET meta_title = EXCLUDED.meta_title,
              meta_description = EXCLUDED.meta_description,
              canonical_url = EXCLUDED.canonical_url,
              focus_keyword = EXCLUDED.focus_keyword,
              updated_at = now()
      `);
    }

    count++;
  }

  return { upserted: count };
}
