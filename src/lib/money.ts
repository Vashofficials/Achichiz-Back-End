/**
 * Every money value in this system is an INTEGER NUMBER OF PAISE.
 *
 * No floats. No `NUMERIC` round-tripped through JS. No `0.1 + 0.2`. The database
 * stores BIGINT paise, the API emits integer paise, and the frontend divides by
 * 100 exactly once, at render time.
 */
export type Paise = number;

export const RUPEE = 100;

export function assertPaise(value: number, label = 'amount'): Paise {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be an integer number of paise, received ${value}`);
  }
  return value;
}

export const rupeesToPaise = (rupees: number): Paise => Math.round(rupees * RUPEE);
export const paiseToRupees = (paise: Paise): number => paise / RUPEE;

/** For logs and emails only — never for arithmetic. */
export const formatInr = (paise: Paise): string =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 }).format(
    paiseToRupees(paise),
  );

export const sum = (values: readonly Paise[]): Paise => values.reduce((a, b) => a + b, 0);

/** Basis points: 250 bp = 2.5%. Integer percentages are not enough — shipping slabs use fractions. */
export type BasisPoints = number;
export const BP_DENOMINATOR = 10_000;

export const applyBasisPoints = (amount: Paise, bp: BasisPoints): Paise =>
  Math.round((amount * bp) / BP_DENOMINATOR);

/**
 * Distribute `total` across `weights` so the parts sum EXACTLY to `total`.
 *
 * Used for allocating an order-level discount or shipping fee down to lines
 * (each line needs its own taxable value for the GST invoice). Largest-remainder
 * method: floor everything, then hand the leftover paise one at a time to the
 * lines with the biggest fractional part. Deterministic, and the total is never
 * off by a paisa.
 */
export function allocate(total: Paise, weights: readonly number[]): Paise[] {
  assertPaise(total, 'total');
  const weightTotal = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) return [];
  if (weightTotal <= 0) {
    // Nothing to weight by — spread as evenly as possible.
    const base = Math.floor(total / weights.length);
    const out = weights.map(() => base);
    let leftover = total - base * weights.length;
    for (let i = 0; leftover > 0; i = (i + 1) % out.length, leftover--) {
      out[i] = (out[i] ?? 0) + 1;
    }
    return out;
  }

  const exact = weights.map((w) => (total * w) / weightTotal);
  const floors = exact.map((v) => Math.floor(v));
  let remainder = total - floors.reduce((a, b) => a + b, 0);

  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const out = [...floors];
  for (let k = 0; remainder > 0; k = (k + 1) % order.length, remainder--) {
    const idx = order[k]!.i;
    out[idx] = (out[idx] ?? 0) + 1;
  }
  return out;
}
