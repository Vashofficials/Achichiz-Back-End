const fs = require('fs');
const path = 'C:/Achichiz/Website 2.0/Back-End/src/modules/admin-resources/resource.registry.ts';
let content = fs.readFileSync(path, 'utf8');

content = content.replace('contentType: mediaAssets.contentType,', 'mimeType: mediaAssets.mimeType,');
content = content.replace('sizeBytes: mediaAssets.sizeBytes,', 'bytes: mediaAssets.bytes,');
content = content.replace('width: mediaAssets.width,', 'widthPx: mediaAssets.widthPx,');
content = content.replace('height: mediaAssets.height,', 'heightPx: mediaAssets.heightPx,');

content = content.replace("listColumns: ['filename', 'contentType', 'sizeBytes'],", "listColumns: ['filename', 'mimeType', 'bytes'],");

content = content.replace("{ key: 'contentType', label: 'MIME Type', kind: 'text', required: true, max: 120 },", "{ key: 'mimeType', label: 'MIME Type', kind: 'text', required: true, max: 120 },");

fs.writeFileSync(path, content, 'utf8');
