import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildAllDocuments } from './document.js';

/**
 * Writes the OpenAPI documents to disk.
 *
 * The output is COMMITTED. CI runs this and then `git diff --exit-code`, so
 * changing a schema without regenerating turns the build red. That is gate 1 of 3
 * — the other two are the route-coverage test and spectral.
 *
 * Importing ./routes.js is what populates the registry: every module's
 * `defineRoute` calls run at import time.
 */
async function main(): Promise<void> {
  await import('../../routes.js');

  const docs = buildAllDocuments();
  const outDir = resolve(process.cwd(), 'openapi');

  for (const [surface, doc] of Object.entries(docs)) {
    const file = resolve(outDir, `openapi.${surface}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    const pathCount = Object.keys(doc.paths as Record<string, unknown>).length;
    // eslint-disable-next-line no-console
    console.log(`wrote ${file} (${pathCount} paths)`);
  }

  // Importing the route graph transitively constructs the pg Pool and the Redis
  // clients. Both are lazy, so nothing connects — but the Pool still registers
  // handles that can outlive this script. Exit explicitly rather than trusting
  // the event loop to drain, or the CI OpenAPI gate hangs instead of failing.
  process.exit(0);
}

main().catch((err: unknown) => {
   
  console.error(err);
  process.exit(1);
});
