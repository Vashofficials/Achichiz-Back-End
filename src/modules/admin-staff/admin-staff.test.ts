import { describe, expect, it } from 'vitest';
import {
  inviteStaffBody,
  staffListQuery,
  staffStatus,
  updateStaffBody,
} from './admin-staff.schemas.js';
import { STAFF_STATUSES } from '../../db/schema/index.js';

/**
 * The staff contracts are pure, so they are tested here without a database.
 *
 * What they protect is concrete: `staff_users` carries three CHECK constraints
 * and a PARTIAL unique index, and a request that slips past zod only fails later
 * as a Postgres integrity error — a 500 where the caller deserved a 422 telling
 * them what to fix.
 */

const ROLE = '2f1c8f3e-0e2a-4c5b-9d21-6a7f0b3c4d5e';
const WAREHOUSE = '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

describe('status vocabulary', () => {
  it('is exactly what the database CHECK allows', () => {
    // If these ever diverge, the API accepts a status the table rejects and the
    // write dies at the constraint instead of at validation.
    expect([...staffStatus.options].sort()).toEqual([...STAFF_STATUSES].sort());
  });

  it('does not include a "deleted" status — removal is deleted_at, not a status', () => {
    expect(staffStatus.options).not.toContain('deleted');
  });
});

describe('inviteStaffBody', () => {
  it('accepts a minimal invite and defaults the scope to absent (= all warehouses)', () => {
    const parsed = inviteStaffBody.parse({
      fullName: 'Pooja Singh',
      email: 'pooja.singh@achichiz.in',
      roleId: ROLE,
    });
    expect(parsed.warehouseScope).toBeUndefined();
  });

  it('lower-cases the email before it is ever compared', () => {
    // `uq_staff_email` is a plain unique index on a CITEXT column; the service
    // also compares with lower(). Normalising at the edge keeps the stored value
    // and the comparison in agreement.
    const parsed = inviteStaffBody.parse({
      fullName: 'Pooja Singh',
      email: '  Pooja.Singh@Achichiz.IN  ',
      roleId: ROLE,
    });
    expect(parsed.email).toBe('pooja.singh@achichiz.in');
  });

  it('rejects a non-uuid role rather than passing it to a FK', () => {
    expect(inviteStaffBody.safeParse({ fullName: 'A', email: 'a@b.co', roleId: 'admin' }).success).toBe(false);
  });

  it('rejects a blank name that a NOT NULL column would happily store', () => {
    expect(inviteStaffBody.safeParse({ fullName: '   ', email: 'a@b.co', roleId: ROLE }).success).toBe(false);
  });

  it('requires warehouse scope entries to be ids, not labels', () => {
    const bad = inviteStaffBody.safeParse({
      fullName: 'A',
      email: 'a@b.co',
      roleId: ROLE,
      warehouseScope: ['Mumbai Atelier (Andheri)'],
    });
    expect(bad.success).toBe(false);
    expect(inviteStaffBody.safeParse({ fullName: 'A', email: 'a@b.co', roleId: ROLE, warehouseScope: [WAREHOUSE] }).success).toBe(true);
  });
});

describe('updateStaffBody', () => {
  it('refuses an empty patch instead of issuing a no-op UPDATE', () => {
    expect(updateStaffBody.safeParse({}).success).toBe(false);
  });

  it('accepts a single field', () => {
    expect(updateStaffBody.safeParse({ fullName: 'Renamed' }).success).toBe(true);
  });

  it('accepts an empty warehouse scope — that is "all warehouses", not "none"', () => {
    const parsed = updateStaffBody.parse({ warehouseScope: [] });
    expect(parsed.warehouseScope).toEqual([]);
  });

  it('will not let a PATCH move an account back to `invited`', () => {
    // Only the invite endpoint creates that state. Hand-setting it would orphan
    // an account that already has a password.
    expect(updateStaffBody.safeParse({ status: 'invited' }).success).toBe(false);
    expect(updateStaffBody.safeParse({ status: 'active' }).success).toBe(true);
    expect(updateStaffBody.safeParse({ status: 'suspended' }).success).toBe(true);
  });
});

describe('staffListQuery', () => {
  it('applies the shared pagination defaults', () => {
    const q = staffListQuery.parse({});
    expect(q.page).toBe(1);
    expect(q.perPage).toBe(25);
  });

  it('enforces the shared per-page ceiling', () => {
    expect(staffListQuery.safeParse({ perPage: 1000 }).success).toBe(false);
  });

  it('rejects a status filter outside the vocabulary', () => {
    expect(staffListQuery.safeParse({ status: 'deleted' }).success).toBe(false);
  });
});
