import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NotFoundError, UnprocessableError } from '../../lib/errors.js';
import * as service from './admin-returns.service.js';
import { db } from '../../config/db.js';
import * as payments from '../payments/payments.service.js';

vi.mock('../../config/db.js', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../payments/payments.service.js', () => ({
  refundOrder: vi.fn(),
}));

describe('admin-returns — refundReturn state guards and refund amount caps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws NotFoundError when the return does not exist', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    await expect(service.refundReturn('00000000-0000-0000-0000-000000000001', 5000)).rejects.toThrow(
      NotFoundError,
    );
  });

  it('throws UnprocessableError (422) when the return is not in approved state', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([
            { id: 'ret-1', status: 'requested', orderId: 'ord-1' },
          ]),
        }),
      }),
    } as any);

    await expect(service.refundReturn('ret-1', 5000)).rejects.toThrow(UnprocessableError);
    await expect(service.refundReturn('ret-1', 5000)).rejects.toThrow(/cannot be refunded/);
  });

  it('throws UnprocessableError (422) with code refund_exceeds_max when refundPaise exceeds sum of returned lines value', async () => {
    let callCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // First call: query returns
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                { id: 'ret-1', status: 'approved', orderId: 'ord-1' },
              ]),
            }),
          }),
        } as any;
      } else {
        // Second call: query returnLines + orderLines
        // Line 1: ordered qty 2, gross 10,000 paise (₹100). Returning 1 unit -> paid value 5,000 paise
        // Line 2: ordered qty 1, gross 4,000 paise (₹40). Returning 1 unit -> paid value 4,000 paise
        // Total max allowable refund = 9,000 paise (₹90)
        return {
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([
                { id: 'rl-1', quantity: 1, orderLineQuantity: 2, orderLineGrossPaise: 10000 },
                { id: 'rl-2', quantity: 1, orderLineQuantity: 1, orderLineGrossPaise: 4000 },
              ]),
            }),
          }),
        } as any;
      }
    });

    // Attempting to refund 9,001 paise (exceeds 9,000 max)
    try {
      await service.refundReturn('ret-1', 9001);
      expect.unreachable('Should have thrown UnprocessableError');
    } catch (err: any) {
      expect(err).toBeInstanceOf(UnprocessableError);
      expect(err.status).toBe(422);
      expect(err.code).toBe('refund_exceeds_max');
      expect(err.message).toMatch(/exceeds the maximum allowable refund of 9000 paise/);
    }
  });

  it('succeeds when refundPaise is within allowable limit and calls payment gateway', async () => {
    let callCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                { id: 'ret-1', status: 'approved', orderId: 'ord-1' },
              ]),
            }),
          }),
        } as any;
      } else {
        return {
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([
                { id: 'rl-1', quantity: 1, orderLineQuantity: 2, orderLineGrossPaise: 10000 },
              ]),
            }),
          }),
        } as any;
      }
    });

    vi.mocked(payments.refundOrder).mockResolvedValue({
      refundId: 'ref-123',
      refundNo: 'REF-001',
      status: 'initiated',
      gatewayRefundId: 'rfnd_gw_xyz',
    });

    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([
            { id: 'ret-1', status: 'refunded', refundPaise: 5000 },
          ]),
        }),
      }),
    } as any);

    const result = await service.refundReturn('ret-1', 5000);
    expect(result.status).toBe('refunded');
    expect(result.gatewayRefundId).toBe('rfnd_gw_xyz');
    expect(payments.refundOrder).toHaveBeenCalledWith({
      orderId: 'ord-1',
      amountPaise: 5000,
      reason: 'Return ret-1',
      idempotencyKey: 'return-refund-ret-1',
    });
  });
});
