import { eq, ilike, and, or, inArray, sql, asc, desc, count } from 'drizzle-orm';
import { db, type Tx } from '../../config/db.js';
import {
  builderTemplates,
  builderTemplateSteps,
  builderStepOptions,
} from '../../db/schema/index.js';
import type { BuilderTemplateListQuery, CreateBuilderTemplateBody, UpdateBuilderTemplateBody } from './admin-builder.schemas.js';

export async function listBuilderTemplates(query: BuilderTemplateListQuery) {
  let where = sql`deleted_at IS NULL`;
  if (query.status) {
    where = and(where, eq(builderTemplates.status, query.status))!;
  }
  if (query.q) {
    where = and(where, or(ilike(builderTemplates.name, `%${query.q}%`), ilike(builderTemplates.handle, `%${query.q}%`)))!;
  }

  const offset = (query.page - 1) * query.perPage;
  
  const rows = await db
    .select()
    .from(builderTemplates)
    .where(where)
    .orderBy(desc(builderTemplates.createdAt))
    .limit(query.perPage)
    .offset(offset);
    
  return rows;
}

export async function countBuilderTemplates(query: BuilderTemplateListQuery): Promise<number> {
  let where = sql`deleted_at IS NULL`;
  if (query.status) {
    where = and(where, eq(builderTemplates.status, query.status))!;
  }
  if (query.q) {
    where = and(where, or(ilike(builderTemplates.name, `%${query.q}%`), ilike(builderTemplates.handle, `%${query.q}%`)))!;
  }

  const [row] = await db
    .select({ count: count() })
    .from(builderTemplates)
    .where(where);
  
  return row?.count ?? 0;
}

export async function getBuilderTemplateWithSteps(id: string) {
  const row = await db.query.builderTemplates.findFirst({
    where: and(eq(builderTemplates.id, id), sql`deleted_at IS NULL`),
  });
  
  if (!row) return null;
  
  const steps = await db.query.builderTemplateSteps.findMany({
    where: eq(builderTemplateSteps.templateId, id),
    orderBy: [asc(builderTemplateSteps.position)],
  });
  
  const stepIds = steps.map(s => s.id);
  let options: any[] = [];
  
  if (stepIds.length > 0) {
    options = await db.query.builderStepOptions.findMany({
      where: inArray(builderStepOptions.stepId, stepIds),
      orderBy: [asc(builderStepOptions.position)],
    });
  }
  
  const stepsWithOptions = steps.map((step: any) => ({
    ...step,
    options: options.filter((o: any) => o.stepId === step.id),
  }));
  
  return {
    ...row,
    steps: stepsWithOptions,
  };
}

export async function insertBuilderTemplate(body: CreateBuilderTemplateBody, tx: Tx): Promise<string> {
  const [template] = await tx.insert(builderTemplates).values({
    handle: body.handle,
    name: body.name,
    basePricePaise: body.basePricePaise,
    maxWeightGrams: body.maxWeightGrams ?? null,
    status: body.status,
  }).returning({ id: builderTemplates.id });
  
  if (body.steps && body.steps.length > 0) {
    for (const step of body.steps) {
      const [stepRow] = await tx.insert(builderTemplateSteps).values({
        templateId: template!.id,
        position: step.position,
        title: step.title,
        note: step.note ?? null,
        minChoices: step.minChoices,
        maxChoices: step.maxChoices,
        stepKind: step.stepKind,
      }).returning({ id: builderTemplateSteps.id });
      
      if (step.options && step.options.length > 0) {
        const optionValues = step.options.map((opt: any) => ({
          stepId: stepRow!.id,
          hamperItemId: opt.hamperItemId ?? null,
          variantId: opt.variantId ?? null,
          packagingId: opt.packagingId ?? null,
          label: opt.label,
          pricePaise: opt.pricePaise,
          weightGrams: opt.weightGrams ?? null,
          position: opt.position,
          isAvailable: opt.isAvailable,
        }));
        await tx.insert(builderStepOptions).values(optionValues);
      }
    }
  }
  
  return template!.id;
}

export async function updateBuilderTemplate(id: string, body: UpdateBuilderTemplateBody, tx: Tx): Promise<void> {
  await tx.update(builderTemplates).set({
    handle: body.handle,
    name: body.name,
    basePricePaise: body.basePricePaise,
    maxWeightGrams: body.maxWeightGrams,
    status: body.status,
    updatedAt: sql`NOW()`,
  }).where(eq(builderTemplates.id, id));
  
  if (body.steps) {
    // Overwrite all steps for simplicity
    await tx.delete(builderTemplateSteps).where(eq(builderTemplateSteps.templateId, id));
    
    for (const step of body.steps) {
      const [stepRow] = await tx.insert(builderTemplateSteps).values({
        templateId: id,
        position: step.position,
        title: step.title,
        note: step.note ?? null,
        minChoices: step.minChoices,
        maxChoices: step.maxChoices,
        stepKind: step.stepKind,
      }).returning({ id: builderTemplateSteps.id });
      
      if (step.options && step.options.length > 0) {
        const optionValues = step.options.map((opt: any) => ({
          stepId: stepRow!.id,
          hamperItemId: opt.hamperItemId ?? null,
          variantId: opt.variantId ?? null,
          packagingId: opt.packagingId ?? null,
          label: opt.label,
          pricePaise: opt.pricePaise,
          weightGrams: opt.weightGrams ?? null,
          position: opt.position,
          isAvailable: opt.isAvailable,
        }));
        await tx.insert(builderStepOptions).values(optionValues);
      }
    }
  }
}

export async function softDeleteBuilderTemplate(id: string): Promise<boolean> {
  const result = await db.update(builderTemplates)
    .set({ deletedAt: sql`NOW()`, updatedAt: sql`NOW()` })
    .where(and(eq(builderTemplates.id, id), sql`deleted_at IS NULL`));
  return (result.rowCount ?? 0) > 0;
}
