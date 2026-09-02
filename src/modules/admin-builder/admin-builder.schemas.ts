import { z } from 'zod';
import { BUILDER_TEMPLATE_STATUSES, BUILDER_STEP_KINDS } from '../../db/schema/catalogue.js';
import { listQuery } from '../../lib/pagination.js';

export const builderOptionSchema = z.object({
  id: z.string().uuid().optional(),
  hamperItemId: z.string().uuid().nullable().optional(),
  variantId: z.string().uuid().nullable().optional(),
  packagingId: z.string().uuid().nullable().optional(),
  label: z.string().trim().min(1),
  pricePaise: z.number().int().min(0),
  weightGrams: z.number().int().min(0).nullable().optional(),
  position: z.number().int(),
  isAvailable: z.boolean().default(true),
});

export const builderStepSchema = z.object({
  id: z.string().uuid().optional(),
  position: z.number().int(),
  title: z.string().trim().min(1),
  note: z.string().trim().nullable().optional(),
  minChoices: z.number().int().min(0),
  maxChoices: z.number().int().min(1),
  stepKind: z.enum(BUILDER_STEP_KINDS),
  options: z.array(builderOptionSchema),
});

export const builderTemplateDetail = z.object({
  id: z.string().uuid(),
  handle: z.string(),
  name: z.string(),
  basePricePaise: z.number().int(),
  maxWeightGrams: z.number().int().nullable(),
  status: z.enum(BUILDER_TEMPLATE_STATUSES),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  steps: z.array(builderStepSchema),
});

export const createBuilderTemplateBody = z.object({
  handle: z.string().trim().min(1),
  name: z.string().trim().min(1),
  basePricePaise: z.number().int().min(0),
  maxWeightGrams: z.number().int().nullable().optional(),
  status: z.enum(BUILDER_TEMPLATE_STATUSES).default('draft'),
  steps: z.array(builderStepSchema).default([]),
});

export const updateBuilderTemplateBody = createBuilderTemplateBody.partial();

export const builderTemplateListQuery = listQuery.extend({
  q: z.string().optional(),
  status: z.enum(BUILDER_TEMPLATE_STATUSES).optional(),
});
export type BuilderTemplateListQuery = z.infer<typeof builderTemplateListQuery>;
export type CreateBuilderTemplateBody = z.infer<typeof createBuilderTemplateBody>;
export type UpdateBuilderTemplateBody = z.infer<typeof updateBuilderTemplateBody>;