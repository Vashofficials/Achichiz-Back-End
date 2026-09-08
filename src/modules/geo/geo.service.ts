/**
 * Reverse geocoding — browser coordinates to a saveable Achichiz address.
 *
 * The storefront asks for location permission, gets a lat/lng, and needs it turned into
 * something that can populate the address form. That conversion belongs here rather than in the
 * browser for two reasons:
 *
 *   1. `addresses.state_code` is a foreign key to `gst_states`, and it decides whether an order
 *      is taxed IGST or CGST+SGST. Google returns "Uttar Pradesh"; only the server knows that is
 *      `09`. A frontend guessing at that writes wrong invoices.
 *   2. The geocoding key has to be IP-restricted to be safe, which a browser cannot satisfy.
 *
 * Serviceability is folded into the same response so one call answers both "where am I" and
 * "can you deliver here" — the storefront needs them together and would otherwise round-trip
 * twice before it can show anything.
 */

import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { UnprocessableError, UpstreamError } from '../../lib/errors.js';
import { checkServiceability } from '../catalogue/catalogue.service.js';
import { db } from '../../config/db.js';
import { gstStates } from '../../db/schema/index.js';
import { eq, sql } from 'drizzle-orm';

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const TIMEOUT_MS = 5_000;

/** Google address_component, narrowed to what we read. */
type Component = { long_name: string; short_name: string; types: string[] };

type GeocodeResponse = {
  status: string;
  error_message?: string;
  results: { formatted_address: string; address_components: Component[] }[];
};

const pick = (components: Component[], type: string): Component | undefined =>
  components.find((c) => c.types.includes(type));

/**
 * Map a state name to its GST code.
 *
 * Google spells states as the state government does; `gst_states.name` follows the GST
 * notification. They agree far more often than not, so an exact case-insensitive match first,
 * then a loose match that tolerates "&" vs "and" and the Union Territory suffixes.
 */
async function gstCodeForState(stateName: string): Promise<string | null> {
  const normalised = stateName.trim().toLowerCase().replace(/\s*&\s*/g, ' and ').replace(/\s+/g, ' ');

  const rows = await db
    .select({ code: gstStates.code, name: gstStates.name })
    .from(gstStates)
    .where(
      sql`lower(regexp_replace(replace(${gstStates.name}, '&', 'and'), '\\s+', ' ', 'g')) = ${normalised}`,
    )
    .limit(1);

  if (rows[0]) return rows[0].code;

  // Fall back to a prefix match — "Delhi" against "Delhi (NCT)", say.
  const loose = await db
    .select({ code: gstStates.code })
    .from(gstStates)
    .where(sql`lower(${gstStates.name}) like ${normalised.split(' ')[0] + '%'}`)
    .limit(1);

  return loose[0]?.code ?? null;
}

export type ReverseGeocodeResult = {
  line1: string;
  area: string | null;
  city: string | null;
  stateCode: string | null;
  stateName: string | null;
  pincode: string | null;
  formattedAddress: string;
  /** Present only when a PIN code was resolved — the storefront shows it immediately. */
  serviceability: Awaited<ReturnType<typeof checkServiceability>> | null;
};

export async function reverseGeocode(lat: number, lng: number): Promise<ReverseGeocodeResult> {
  if (!env.GOOGLE_MAPS_API_KEY) {
    throw new UpstreamError('Location lookup is not configured. Enter the address manually.');
  }

  const url = `${GEOCODE_URL}?latlng=${lat},${lng}&region=in&key=${env.GOOGLE_MAPS_API_KEY}`;

  // A hung upstream must not hold a customer on a spinner: abort and let them type instead.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let body: GeocodeResponse;
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new UpstreamError('Location lookup failed. Enter the address manually.');
    }
    body = (await response.json()) as GeocodeResponse;
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    // Never leak the upstream error text — it can echo the key back.
    logger.warn({ err }, 'reverse geocoding request failed');
    throw new UpstreamError('Location lookup timed out. Enter the address manually.');
  } finally {
    clearTimeout(timer);
  }

  // Status FIRST, then emptiness. Reversing these masks a broken key: REQUEST_DENIED and
  // OVER_QUERY_LIMIT both arrive with an empty `results`, and reporting those as "no address
  // at that location" sends whoever is debugging to the customer's coordinates instead of to
  // the Google Cloud console. `error_message` goes to the log only — it can echo the key.
  if (body.status !== 'OK' && body.status !== 'ZERO_RESULTS') {
    logger.warn(
      { status: body.status, errorMessage: body.error_message },
      'geocoding returned a non-OK status',
    );
    throw new UpstreamError('Location lookup failed. Enter the address manually.');
  }
  if (body.status === 'ZERO_RESULTS' || body.results.length === 0) {
    throw new UnprocessableError(
      'No address found at that location. Enter the address manually.',
      'no_address_at_location',
    );
  }

  const result = body.results[0]!;
  const components = result.address_components;

  const streetNumber = pick(components, 'street_number')?.long_name;
  const route = pick(components, 'route')?.long_name;
  const premise = pick(components, 'premise')?.long_name;
  const sublocality =
    pick(components, 'sublocality_level_1')?.long_name ?? pick(components, 'sublocality')?.long_name;
  const city =
    pick(components, 'locality')?.long_name ??
    pick(components, 'administrative_area_level_3')?.long_name ??
    null;
  const stateName = pick(components, 'administrative_area_level_1')?.long_name ?? null;
  const pincode = pick(components, 'postal_code')?.long_name ?? null;

  // line1 is the house/street portion only. The customer almost always corrects it, so a
  // best-effort join beats an over-clever guess; area and city are separate fields anyway.
  const line1 = [premise, streetNumber, route].filter(Boolean).join(', ') || result.formatted_address;

  const stateCode = stateName ? await gstCodeForState(stateName) : null;

  // A PIN code we cannot serve is still worth returning — the UI says so rather than
  // silently accepting an address it will refuse at checkout.
  const serviceability = pincode ? await checkServiceability(pincode).catch(() => null) : null;

  return {
    line1,
    area: sublocality ?? null,
    city,
    stateCode,
    stateName,
    pincode,
    formattedAddress: result.formatted_address,
    serviceability,
  };
}
