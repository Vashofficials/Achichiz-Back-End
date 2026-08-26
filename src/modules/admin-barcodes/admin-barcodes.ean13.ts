/**
 * EAN-13 — the check digit and nothing else. Pure, no I/O, no database.
 *
 * A barcode is a number a scanner reads off a label and a human never verifies.
 * The check digit is the only thing standing between a mis-scan and a movement
 * posted against the wrong SKU, so the arithmetic lives in one file with a test
 * that pins it against published, known-good symbols rather than against itself.
 *
 * ## The algorithm
 *
 * An EAN-13 is 12 payload digits plus one check digit. Weight the payload from
 * the LEFT, 1-indexed: odd positions ×1, even positions ×3. The check digit is
 * whatever takes that weighted sum up to the next multiple of ten.
 *
 * ```
 *   sum   = Σ dᵢ × (i odd ? 1 : 3)      for i = 1..12
 *   check = (10 − sum mod 10) mod 10
 * ```
 *
 * The outer `mod 10` is the case worth being explicit about: when the sum is
 * already a multiple of ten the check digit is 0, not 10. `10 - 0` is the classic
 * off-by-one that produces a 14-character "EAN-13" nobody notices until a
 * scanner refuses it.
 *
 * ## The prefix
 *
 * Codes minted here are for internal circulation. GS1 reserves the 2xx prefix
 * range for restricted distribution — codes that are meaningful inside one
 * company and are guaranteed never to collide with a manufacturer's registered
 * GS1 prefix. Anything printed on goods that leave the building for retail sale
 * needs a real GS1 company prefix, which is bought, not generated; this module
 * cannot and does not mint those, and the default prefix is chosen so that it is
 * obvious it did not.
 */

/** GS1 restricted-circulation range. Safe to mint; never a registered company prefix. */
export const INTERNAL_PREFIXES = ['20', '21', '22', '23', '24', '25', '26', '27', '28', '29'] as const;
export type InternalPrefix = (typeof INTERNAL_PREFIXES)[number];

export const DEFAULT_PREFIX: InternalPrefix = '29';

export const EAN13_LENGTH = 13;
const PAYLOAD_LENGTH = 12;

const DIGITS_ONLY = /^\d+$/;

/**
 * The weighted sum over 12 payload digits.
 *
 * Throws rather than returning NaN on bad input: a silently-wrong check digit is
 * a barcode that scans and means the wrong thing, which is worse than a 500.
 */
export function ean13WeightedSum(payload: string): number {
  if (payload.length !== PAYLOAD_LENGTH || !DIGITS_ONLY.test(payload)) {
    throw new Error(`EAN-13 payload must be exactly ${PAYLOAD_LENGTH} digits; got '${payload}'.`);
  }

  let sum = 0;
  for (let i = 0; i < PAYLOAD_LENGTH; i += 1) {
    // i is 0-indexed, so i even ⇒ 1-indexed odd ⇒ weight 1.
    sum += Number(payload[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return sum;
}

/** The 13th digit for a 12-digit payload. `(10 - sum % 10) % 10` — never 10. */
export function ean13CheckDigit(payload: string): number {
  return (10 - (ean13WeightedSum(payload) % 10)) % 10;
}

/** 12 digits in, 13 out. The only sanctioned way to build one. */
export function completeEan13(payload: string): string {
  return `${payload}${ean13CheckDigit(payload)}`;
}

/**
 * Is this a well-formed EAN-13 whose check digit agrees with its payload?
 *
 * Used on the way IN as well as on the way out: an operator-supplied barcode that
 * fails this is a typo, and storing it means the label on the shelf and the row
 * in the database disagree forever.
 */
export function isValidEan13(code: string): boolean {
  if (code.length !== EAN13_LENGTH || !DIGITS_ONLY.test(code)) return false;
  return ean13CheckDigit(code.slice(0, PAYLOAD_LENGTH)) === Number(code[PAYLOAD_LENGTH]);
}

/**
 * Assemble a code from a prefix and a body of random digits.
 *
 * `prefix + body` must be exactly 12 digits; the check digit is appended. Kept
 * separate from the randomness so the assembly is testable with fixed input —
 * a generator that can only be tested statistically is a generator nobody tests.
 */
export function buildEan13(prefix: string, body: string): string {
  const payload = `${prefix}${body}`;
  if (payload.length !== PAYLOAD_LENGTH) {
    throw new Error(
      `prefix '${prefix}' + body '${body}' is ${payload.length} digits; an EAN-13 payload is ${PAYLOAD_LENGTH}.`,
    );
  }
  return completeEan13(payload);
}

/** How many random digits a given prefix leaves room for. */
export const bodyLengthFor = (prefix: string): number => PAYLOAD_LENGTH - prefix.length;

/**
 * `randomDigits` is injected so the generator is deterministic under test.
 *
 * The service passes a CSPRNG-backed implementation. Predictable barcodes are
 * not a confidentiality problem, but a generator seeded from the clock produces
 * runs of near-identical codes across a bulk batch, which is exactly where
 * collisions cluster.
 */
export type DigitSource = (length: number) => string;

/** One candidate code for a prefix, from an injected digit source. */
export const mintEan13 = (prefix: string, randomDigits: DigitSource): string =>
  buildEan13(prefix, randomDigits(bodyLengthFor(prefix)));

/**
 * A batch of DISTINCT candidates.
 *
 * Distinctness inside the batch is checked here, before anything reaches the
 * database, because `uq_variants_barcode` would otherwise abort the whole
 * all-or-nothing transaction on the second colliding row and tell the operator
 * nothing useful about which two lines clashed. Collisions against codes already
 * in the table are a separate check the repository does — this function cannot
 * see them.
 *
 * Gives up after `maxAttempts` total draws rather than looping forever on a
 * degenerate digit source.
 */
export function mintDistinctEan13(
  prefix: string,
  count: number,
  randomDigits: DigitSource,
  options: { exclude?: ReadonlySet<string>; maxAttempts?: number } = {},
): string[] {
  const exclude = options.exclude ?? new Set<string>();
  const maxAttempts = options.maxAttempts ?? Math.max(64, count * 16);

  const minted: string[] = [];
  const seen = new Set<string>();

  for (let attempt = 0; attempt < maxAttempts && minted.length < count; attempt += 1) {
    const candidate = mintEan13(prefix, randomDigits);
    if (seen.has(candidate) || exclude.has(candidate)) continue;
    seen.add(candidate);
    minted.push(candidate);
  }

  if (minted.length < count) {
    throw new Error(
      `Could not mint ${count} distinct EAN-13 codes under prefix '${prefix}' in ${maxAttempts} attempts.`,
    );
  }
  return minted;
}
