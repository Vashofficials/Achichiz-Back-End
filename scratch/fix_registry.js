const fs = require('fs');
const file = 'c:/Achichiz/Website 2.0/Back-End/src/modules/admin-resources/resource.registry.ts';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(/type: 'string'/g, "kind: 'text'");
content = content.replace(/type: 'json'/g, "kind: 'object'");

content = content.replace(
  /id: integrations\.id,[\s\S]*?updatedAt: integrations\.updatedAt,/m,
  `id: integrations.id,
    key: integrations.key,
    name: integrations.name,
    category: integrations.category,
    status: integrations.status,
    credentialsRef: integrations.credentialsRef,
    config: integrations.config,
    createdAt: integrations.createdAt,
    updatedAt: integrations.updatedAt,`
);

content = content.replace(
  /listColumns: \['provider', 'status', 'createdAt'\],/,
  "listColumns: ['name', 'category', 'status', 'createdAt'],"
);

content = content.replace(
  /fields: \[\s*\{ key: 'provider'[\s\S]*?\{ key: 'settings'[\s\S]*?\],/m,
  `fields: [
    { key: 'key', kind: 'text', required: true, label: 'Key' },
    { key: 'name', kind: 'text', required: true, label: 'Name' },
    { key: 'category', kind: 'text', required: true, label: 'Category' },
    { key: 'status', kind: 'text', required: true, label: 'Status' },
    { key: 'credentialsRef', kind: 'text', required: false, label: 'Credentials Ref' },
    { key: 'config', kind: 'object', required: false, label: 'Config' },
  ],`
);

content = content.replace(
  /filters: \[enumFilter\('status', 'Status', integrations\.status, \['connected', 'disconnected', 'error'\]\)\],/,
  "filters: [enumFilter('status', 'Status', integrations.status, ['connected', 'not_connected', 'error'])],"
);

content = content.replace(
  /searchFields: \[integrations\.provider\],/,
  "searchFields: [integrations.name, integrations.key],"
);

// Fix activityLogs
content = content.replace(
  /id: activityLogs\.id,[\s\S]*?createdAt: activityLogs\.createdAt,/m,
  `id: activityLogs.id,
    entityType: activityLogs.entityType,
    entityId: activityLogs.entityId,
    action: activityLogs.action,
    actorStaffId: activityLogs.actorStaffId,
    actorCustomerId: activityLogs.actorCustomerId,
    actorApiKeyId: activityLogs.actorApiKeyId,
    occurredAt: activityLogs.occurredAt,`
);

content = content.replace(
  /listColumns: \['entity', 'action', 'createdAt'\],/,
  "listColumns: ['entityType', 'action', 'occurredAt'],"
);

content = content.replace(
  /searchFields: \[activityLogs\.entity, activityLogs\.action\],/,
  "searchFields: [activityLogs.entityType, activityLogs.action],"
);

// Fix webhooks
content = content.replace(
  /\{ key: 'events', kind: 'object', required: true, label: 'Events' \},/,
  "{ key: 'events', kind: 'array', required: true, label: 'Events', of: { key: '', label: '', kind: 'text', required: true } },"
);

// Fix apiKeys
content = content.replace(
  /\{ key: 'scopes', kind: 'object', required: true, label: 'Scopes' \},/,
  "{ key: 'scopes', kind: 'array', required: true, label: 'Scopes', of: { key: '', label: '', kind: 'text', required: true } },"
);

fs.writeFileSync(file, content);
