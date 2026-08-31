/* eslint-disable no-console */
/**
 * Emits the two committed OpenAPI documents.
 *
 * `generate-docs.ts` has told people to run `npm run openapi:generate` for some
 * time, but the script did not exist — so `openapi/*.json` was whatever someone
 * last wrote by hand, and CI Gate 1 (`git diff --exit-code` on these files) was
 * comparing new routes against a stale artifact.
 *
 * Importing `../routes.js` is what populates the registry: `defineRoute` records
 * each operation as the module is evaluated, so the document is empty unless the
 * route modules have been loaded first. That import is the whole point of it
 * being here and not in `document.ts`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildDocument } from '../lib/openapi/document.js';
import '../routes.js';

const ROOT = resolve(import.meta.dirname, '../..');
const OUT = resolve(ROOT, 'openapi');

mkdirSync(OUT, { recursive: true });

for (const surface of ['storefront', 'admin'] as const) {
  const doc = buildDocument(surface);
  const file = resolve(OUT, `openapi.${surface}.json`);
  // Trailing newline and two-space indent so the committed file is diff-stable
  // rather than re-churning on every run.
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  console.log(`${surface.padEnd(11)} ${Object.keys(doc.paths ?? {}).length} paths -> openapi/openapi.${surface}.json`);
}
