/**
 * Location → address, for the "use my current location" step of address entry.
 *
 * Public on purpose: a first-time visitor sets their delivery location before they have an
 * account, exactly as on Amazon and Flipkart. Rate-limited because it costs money per call
 * upstream.
 *
 * Note there is deliberately no PIN-code lookup here — `GET /v1/serviceability` already returns
 * city, GST state code, COD eligibility and a delivery estimate for a PIN code, which is the
 * whole "type a PIN, autofill city and state" behaviour. Use that.
 */

import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { ok } from '../../lib/http.js';
import * as service from './geo.service.js';

export const geoRouter: Router = Router();

const reverseGeocodeQuery = z.object({
  lat: z.coerce
    .number()
    .min(-90)
    .max(90)
    .describe('Latitude from the browser Geolocation API.'),
  lng: z.coerce
    .number()
    .min(-180)
    .max(180)
    .describe('Longitude from the browser Geolocation API.'),
});

const reverseGeocodeResult = z.object({
  line1: z.string().describe('House / street portion. The customer will usually refine it.'),
  area: z.string().nullable().describe('Locality or sub-locality.'),
  city: z.string().nullable(),
  stateCode: z
    .string()
    .nullable()
    .describe('Two-digit GST state code — the value `addresses.stateCode` requires.'),
  stateName: z.string().nullable().describe('Human-readable state, for display only.'),
  pincode: z.string().nullable(),
  formattedAddress: z.string().describe("Google's single-line rendering, for a confirmation line."),
  serviceability: z
    .unknown()
    .nullable()
    .describe(
      'The `GET /v1/serviceability` payload for the resolved PIN code, or null when no PIN ' +
        'code could be resolved. Saves a second round trip before the UI can show anything.',
    ),
});

defineRoute(geoRouter, {
  method: 'get',
  path: '/v1/geo/reverse',
  surface: 'storefront',
  operationId: 'reverseGeocode',
  summary: 'Turn coordinates into an address',
  description:
    'Converts a browser latitude/longitude into address fields ready for the address form, ' +
    'including the GST `stateCode` that `POST /v1/account/addresses` requires — a name like ' +
    '"Uttar Pradesh" is not accepted there, only `09`. Returns serviceability for the resolved ' +
    'PIN code in the same response.\n\n' +
    'Fails soft: a 502 means location lookup is unavailable and the customer should type the ' +
    'address instead. Never block address entry on this endpoint.',
  tags: ['Geo'],
  auth: 'public',
  // Each call costs money at Google. `search` is the existing limiter for cheap-but-metered
  // public lookups; this needs the same treatment rather than a bespoke bucket.
  rateLimit: 'search',
  request: { query: reverseGeocodeQuery },
  responses: {
    200: { description: 'The resolved address.', schema: reverseGeocodeResult },
    422: { description: 'No address exists at those coordinates.' },
    502: { description: 'Location lookup is unavailable or not configured.' },
  },
  handler: async ({ query }) => ok(await service.reverseGeocode(query.lat, query.lng)),
});
