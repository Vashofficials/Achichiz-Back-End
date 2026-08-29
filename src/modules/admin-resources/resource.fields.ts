/**
 * `fields` → zod, and `fields` → the JSON the console's form renderer reads.
 *
 * Generating the request schema from the same spec that generates the form spec
 * is the point: `required` cannot drift between the two, because there is only
 * one of it. A create body is validated against exactly the shape the OpenAPI
 * document publishes, which is what makes `record-form.tsx` schema-driven rather
 * than sample-row-driven.
 */

import { z, type ZodType } from 'zod';
import type { FieldSpec, ResourceDescriptor } from './resource.types.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The base type for a field, before required/nullable is applied. */
function baseSchema(field: FieldSpec): ZodType {
  switch (field.kind) {
    case 'text':
      return z.string().trim().max(field.max ?? 500);
    case 'long':
      return z.string().max(field.max ?? 20_000);
    case 'uuid':
    case 'reference':
      return z.uuid();
    case 'number':
      return z.coerce.number().int().min(field.min ?? -2_147_483_648).max(field.max ?? 2_147_483_647);
    case 'money':
      // Integer paise. A float here is how ₹1,499.00 becomes ₹1,498.9999999998.
      return z.coerce.number().int().min(field.min ?? 0).max(field.max ?? Number.MAX_SAFE_INTEGER);
    case 'percent':
      // Basis points: 250 = 2.5%.
      return z.coerce.number().int().min(field.min ?? 0).max(field.max ?? 1_000_000);
    case 'date':
      return z.string().regex(ISO_DATE, 'Use `YYYY-MM-DD`.');
    case 'datetime':
      return z
        .string()
        .refine((v) => !Number.isNaN(Date.parse(v)), 'Use an ISO-8601 timestamp.');
    case 'boolean':
      return z.union([
        z.boolean(),
        z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')
      ]);
    case 'enum':
      return field.options && field.options.length > 0
        ? z.enum([...field.options] as [string, ...string[]])
        : z.string();
    case 'array':
      return z.array(field.of ? baseSchema(field.of) : z.string()).max(50);
    case 'object':
      return z.record(z.string(), z.unknown());
  }
}

const describe = (field: FieldSpec): string => {
  const unit =
    field.unit === 'paise'
      ? ' Integer paise — 149900 is ₹1,499.00.'
      : field.unit === 'basis_points'
        ? ' Basis points — 250 is 2.5%.'
        : field.unit
          ? ` In ${field.unit}.`
          : '';
  return `${field.label}.${field.help ? ` ${field.help}` : ''}${unit}`;
};

/** Fields a client may actually write. `readOnly` ones are documented, never accepted. */
export const writableFields = (descriptor: ResourceDescriptor): readonly FieldSpec[] =>
  descriptor.fields.filter((f) => !f.readOnly);

/**
 * The create body: required fields required, optional fields nullable.
 *
 * `.strict()` deliberately — an unknown key is a typo or a stale client, and
 * silently dropping it is how a price update appears to succeed without
 * changing the price.
 */
export function createBodySchema(descriptor: ResourceDescriptor): ZodType {
  const shape: Record<string, ZodType> = {};
  for (const field of writableFields(descriptor)) {
    const base = baseSchema(field).describe(describe(field));
    shape[field.key] = field.required ? base : base.nullish();
  }
  return z.strictObject(shape);
}

/**
 * The update body: everything optional, because `record-form.tsx` only ever
 * submits the fields it rendered. That is also why the verb is PATCH — a PUT
 * would promise a full replacement the client has never had the data to make.
 */
export function updateBodySchema(descriptor: ResourceDescriptor): ZodType {
  const shape: Record<string, ZodType> = {};
  for (const field of writableFields(descriptor)) {
    shape[field.key] = baseSchema(field).describe(describe(field)).nullish();
  }
  return z.strictObject(shape).refine((v) => Object.keys(v).length > 0, {
    message: 'Send at least one field to change.',
  });
}

/* --------------------------------------------------- the published schema */

export type PublishedFieldSpec = {
  key: string;
  label: string;
  kind: string;
  required: boolean;
  readOnly: boolean;
  options: readonly string[] | null;
  reference: { resource: string; labelField: string } | null;
  unit: string | null;
  help: string | null;
  of: PublishedFieldSpec | null;
  fields: readonly PublishedFieldSpec[] | null;
};

export function publishField(field: FieldSpec): PublishedFieldSpec {
  return {
    key: field.key,
    label: field.label,
    kind: field.kind,
    required: field.required,
    readOnly: field.readOnly ?? false,
    options: field.options ?? null,
    reference: field.reference ?? null,
    unit: field.unit ?? null,
    help: field.help ?? null,
    of: field.of ? publishField(field.of) : null,
    fields: field.fields ? field.fields.map(publishField) : null,
  };
}
