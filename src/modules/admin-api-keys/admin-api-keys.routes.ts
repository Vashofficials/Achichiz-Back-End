import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { created } from '../../lib/http.js';
import { db } from '../../config/db.js';
import { apiKeys } from '../../db/schema/index.js';

export const adminApiKeysRouter: Router = Router();

// Zod schema for the payload
const createApiKeyBody = z.object({
  label: z.string(),
  environment: z.enum(['live', 'sandbox']).default('live'),
  scopes: z.array(z.string()),
});

// The returned schema contains the `key` ONLY on creation
const createApiKeyResponse = z.object({
  type: z.literal('success'),
  result: z.object({
    id: z.string(),
    label: z.string(),
    keyPrefix: z.string(),
    key: z.string(), // Plain text key!
    environment: z.string(),
    scopes: z.array(z.string()),
    createdAt: z.string(),
  }),
});

defineRoute(adminApiKeysRouter, {
  method: 'post',
  path: '/v1/admin/api-keys',
  surface: 'admin',
  operationId: 'adminCreateApiKey',
  summary: 'Create API Key',
  tags: ['Admin Settings'],
  auth: 'staff',
  permission: { module: 'settings', action: 'manage-settings' },
  request: { body: createApiKeyBody },
  responses: {
    201: { description: 'The newly created API Key', schema: createApiKeyResponse },
  },
  handler: async ({ body, auth }) => {
    // Generate secure API key
    const rawSecret = crypto.randomBytes(32).toString('hex');
    const prefix = body.environment === 'live' ? 'ach_live_' : 'ach_test_';
    const keyPrefix = prefix + rawSecret.substring(0, 4);
    const fullKey = prefix + rawSecret;
    
    // Hash the key for storage (using sha256 for simplicity, or bcrypt if preferred)
    const keyHash = crypto.createHash('sha256').update(fullKey).digest('hex');

    const [inserted] = await db
      .insert(apiKeys)
      .values({
        label: body.label,
        environment: body.environment as any,
        scopes: body.scopes,
        keyPrefix,
        keyHash,
        createdBy: auth.staffId,
      })
      .returning();

    if (!inserted) {
      throw new Error('Failed to create API key');
    }

    return created({
      id: inserted.id,
      label: inserted.label,
      keyPrefix: inserted.keyPrefix,
      key: fullKey,
      environment: inserted.environment,
      scopes: inserted.scopes,
      createdAt: inserted.createdAt.toISOString(),
    });
  },
});
