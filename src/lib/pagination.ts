import { z } from 'zod';

/**
 * Shared pagination/sort/search contract for every list endpoint.
 *
 * The cap matters: the admin's 90 list screens all paginate client-side today
 * over full arrays. Without a hard ceiling, the first thing that happens when
 * they point at a real API is `?perPage=100000`.
 */
export const MAX_PER_PAGE = 100;
export const DEFAULT_PER_PAGE = 25;

export const paginationQuery = z.object({
  page: z.coerce.number().int().positive().default(1).describe('1-indexed page number.'),
  perPage: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_PER_PAGE)
    .default(DEFAULT_PER_PAGE)
    .describe(`Items per page. Maximum ${MAX_PER_PAGE}.`),
});

export const sortQuery = z.object({
  sort: z
    .string()
    .regex(/^-?[a-zA-Z][a-zA-Z0-9_]*$/, 'sort must be a field name, optionally prefixed with `-` for descending')
    .optional()
    .describe('Field to sort by. Prefix with `-` for descending, e.g. `-createdAt`.'),
});

export const searchQuery = z.object({
  q: z.string().trim().min(1).max(120).optional().describe('Free-text search.'),
});

/** The query shape every admin list endpoint accepts. */
export const listQuery = paginationQuery.extend(sortQuery.shape).extend(searchQuery.shape);
export type ListQuery = z.infer<typeof listQuery>;

export const offsetOf = (page: number, perPage: number): number => (page - 1) * perPage;

/** `-createdAt` → `{ field: 'createdAt', direction: 'desc' }` */
export function parseSort(
  sort: string | undefined,
  allowed: readonly string[],
  fallback: { field: string; direction: 'asc' | 'desc' },
): { field: string; direction: 'asc' | 'desc' } {
  if (!sort) return fallback;
  const direction = sort.startsWith('-') ? 'desc' : 'asc';
  const field = sort.replace(/^-/, '');
  // Allowlist, not passthrough — a sort field reaches an ORDER BY clause.
  return allowed.includes(field) ? { field, direction } : fallback;
}
