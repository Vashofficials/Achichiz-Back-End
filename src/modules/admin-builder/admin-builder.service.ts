import { ConflictError, NotFoundError } from '../../lib/errors.js';
import * as repo from './admin-builder.repository.js';
import { db } from '../../config/db.js';
import type {
  BuilderTemplateListQuery,
  CreateBuilderTemplateBody,
  UpdateBuilderTemplateBody,
} from './admin-builder.schemas.js';

export async function listBuilderTemplates(query: BuilderTemplateListQuery) {
  const [rows, total] = await Promise.all([
    repo.listBuilderTemplates(query),
    repo.countBuilderTemplates(query),
  ]);
  
  return { items: rows, total };
}

export async function getBuilderTemplate(id: string) {
  const row = await repo.getBuilderTemplateWithSteps(id);
  if (!row) throw new NotFoundError('Builder template', id);
  return row;
}

export async function createBuilderTemplate(body: CreateBuilderTemplateBody) {
  return db.transaction(async (tx) => {
    const id = await repo.insertBuilderTemplate(body, tx);
    return repo.getBuilderTemplateWithSteps(id);
  });
}

export async function updateBuilderTemplate(id: string, body: UpdateBuilderTemplateBody) {
  return db.transaction(async (tx) => {
    const existing = await repo.getBuilderTemplateWithSteps(id);
    if (!existing) throw new NotFoundError('Builder template', id);
    
    await repo.updateBuilderTemplate(id, body, tx);
    return repo.getBuilderTemplateWithSteps(id);
  });
}

export async function deleteBuilderTemplate(id: string) {
  const deleted = await repo.softDeleteBuilderTemplate(id);
  if (!deleted) throw new NotFoundError('Builder template', id);
}
