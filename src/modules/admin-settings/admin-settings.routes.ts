import { Router } from 'express';
import { defineRoute } from '../../lib/openapi/define-route.js';
import { ok } from '../../lib/http.js';
import * as service from './admin-settings.service.js';
import {
  businessSettingsSchema,
  updateBusinessSettingsBody,
  taxSettingsSchema,
  updateTaxSettingsBody,
  paymentSettingsSchema,
  updatePaymentSettingsBody,
  notificationSettingsSchema,
  updateNotificationSettingsBody,
  securitySettingsSchema,
  updateSecuritySettingsBody,
  settingsResponse,
} from './admin-settings.schemas.js';

export const adminSettingsRouter: Router = Router();

const TAG = 'Admin Settings';

/* ------------------------------------------------------------- Business */
defineRoute(adminSettingsRouter, {
  method: 'get',
  path: '/v1/admin/settings/business',
  surface: 'admin',
  operationId: 'adminGetBusinessSettings',
  summary: 'Get Business Settings',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'settings', action: 'manage-settings' },
  responses: {
    200: { description: 'The business settings', schema: settingsResponse(businessSettingsSchema) },
  },
  handler: async () => ok(await service.getBusinessSettings()),
});

defineRoute(adminSettingsRouter, {
  method: 'patch',
  path: '/v1/admin/settings/business',
  surface: 'admin',
  operationId: 'adminUpdateBusinessSettings',
  summary: 'Update Business Settings',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'settings', action: 'manage-settings' },
  request: { body: updateBusinessSettingsBody },
  responses: {
    200: { description: 'The updated settings', schema: settingsResponse(businessSettingsSchema) },
  },
  handler: async ({ body, auth }) => ok(await service.updateBusinessSettings(body, auth.staffId)),
});

/* ------------------------------------------------------------------ Tax */
defineRoute(adminSettingsRouter, {
  method: 'get',
  path: '/v1/admin/settings/tax',
  surface: 'admin',
  operationId: 'adminGetTaxSettings',
  summary: 'Get Tax Settings',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'settings', action: 'manage-settings' },
  responses: {
    200: { description: 'The tax settings', schema: settingsResponse(taxSettingsSchema) },
  },
  handler: async () => ok(await service.getTaxSettings()),
});

defineRoute(adminSettingsRouter, {
  method: 'patch',
  path: '/v1/admin/settings/tax',
  surface: 'admin',
  operationId: 'adminUpdateTaxSettings',
  summary: 'Update Tax Settings',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'settings', action: 'manage-settings' },
  request: { body: updateTaxSettingsBody },
  responses: {
    200: { description: 'The updated settings', schema: settingsResponse(taxSettingsSchema) },
  },
  handler: async ({ body, auth }) => ok(await service.updateTaxSettings(body, auth.staffId)),
});

/* ------------------------------------------------------------- Payments */
defineRoute(adminSettingsRouter, {
  method: 'get',
  path: '/v1/admin/settings/payments',
  surface: 'admin',
  operationId: 'adminGetPaymentSettings',
  summary: 'Get Payment Settings',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'settings', action: 'manage-settings' },
  responses: {
    200: { description: 'The payment settings', schema: settingsResponse(paymentSettingsSchema) },
  },
  handler: async () => ok(await service.getPaymentSettings()),
});

defineRoute(adminSettingsRouter, {
  method: 'patch',
  path: '/v1/admin/settings/payments',
  surface: 'admin',
  operationId: 'adminUpdatePaymentSettings',
  summary: 'Update Payment Settings',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'settings', action: 'manage-settings' },
  request: { body: updatePaymentSettingsBody },
  responses: {
    200: { description: 'The updated settings', schema: settingsResponse(paymentSettingsSchema) },
  },
  handler: async ({ body, auth }) => ok(await service.updatePaymentSettings(body, auth.staffId)),
});

/* -------------------------------------------------------- Notifications */
defineRoute(adminSettingsRouter, {
  method: 'get',
  path: '/v1/admin/settings/notifications',
  surface: 'admin',
  operationId: 'adminGetNotificationSettings',
  summary: 'Get Notification Settings',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'settings', action: 'manage-settings' },
  responses: {
    200: { description: 'The notification settings', schema: settingsResponse(notificationSettingsSchema) },
  },
  handler: async () => ok(await service.getNotificationSettings()),
});

defineRoute(adminSettingsRouter, {
  method: 'patch',
  path: '/v1/admin/settings/notifications',
  surface: 'admin',
  operationId: 'adminUpdateNotificationSettings',
  summary: 'Update Notification Settings',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'settings', action: 'manage-settings' },
  request: { body: updateNotificationSettingsBody },
  responses: {
    200: { description: 'The updated settings', schema: settingsResponse(notificationSettingsSchema) },
  },
  handler: async ({ body, auth }) => ok(await service.updateNotificationSettings(body, auth.staffId)),
});

/* ------------------------------------------------------------- Security */
defineRoute(adminSettingsRouter, {
  method: 'get',
  path: '/v1/admin/settings/security',
  surface: 'admin',
  operationId: 'adminGetSecuritySettings',
  summary: 'Get Security Settings',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'settings', action: 'manage-settings' },
  responses: {
    200: { description: 'The security settings', schema: settingsResponse(securitySettingsSchema) },
  },
  handler: async () => ok(await service.getSecuritySettings()),
});

defineRoute(adminSettingsRouter, {
  method: 'patch',
  path: '/v1/admin/settings/security',
  surface: 'admin',
  operationId: 'adminUpdateSecuritySettings',
  summary: 'Update Security Settings',
  tags: [TAG],
  auth: 'staff',
  permission: { module: 'settings', action: 'manage-settings' },
  request: { body: updateSecuritySettingsBody },
  responses: {
    200: { description: 'The updated settings', schema: settingsResponse(securitySettingsSchema) },
  },
  handler: async ({ body, auth }) => ok(await service.updateSecuritySettings(body, auth.staffId)),
});
