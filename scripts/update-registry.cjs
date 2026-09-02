const fs = require('fs');
const path = 'C:/Achichiz/Website 2.0/Back-End/src/modules/admin-resources/resource.registry.ts';
let content = fs.readFileSync(path, 'utf8');

if (!content.includes('blogPosts')) {
  content = content.replace(
    /import \{[^}]+\} from '\.\.\/\.\.\/db\/schema\/index\.js';/,
    match => match.replace('cmsSections,', 'cmsSections, blogPosts, menus, mediaAssets,')
  );
}

if (!content.includes('enrichBlogs')) {
  content = content.replace(
    /import \{[^}]+\} from '\.\/enrich\.content\.js';/,
    match => match.replace('enrichSeoEntries', 'enrichSeoEntries, enrichBlogs, enrichMenus, enrichMediaLibrary')
  );
}

const resourcesString = `
const blogPostsResource = defineResource({
  slug: 'blogs',
  title: 'Blogs',
  description: 'Editorial journal posts, authors, and readership.',
  group: 'Content & Storefront',
  module: 'content',
  name: { singular: 'Blog Post', plural: 'Blog Posts' },
  tag: 'Admin content',
  table: blogPosts,
  primaryKey: blogPosts.id,
  columns: {
    id: blogPosts.id,
    slug: blogPosts.slug,
    title: blogPosts.title,
    excerpt: blogPosts.excerpt,
    bodyBlocks: blogPosts.bodyBlocks,
    category: blogPosts.category,
    status: blogPosts.status,
    publishedAt: blogPosts.publishedAt,
    createdAt: blogPosts.createdAt,
    updatedAt: blogPosts.updatedAt,
  },
  listColumns: ['title', 'category', 'status', 'publishedAt'],
  fields: [
    { key: 'title', label: 'Title', kind: 'text', required: true, max: 255 },
    { key: 'slug', label: 'Slug', kind: 'text', required: true, max: 255 },
    { key: 'category', label: 'Category', kind: 'text', required: false, max: 120 },
    { key: 'excerpt', label: 'Excerpt', kind: 'text', required: false },
    { key: 'status', label: 'Status', kind: 'enum', required: true, options: ['published', 'draft', 'scheduled', 'archived'] },
  ],
  searchable: ['title', 'slug', 'category'],
  filterable: [
    enumFilter('status', 'Status', blogPosts.status, ['published', 'draft', 'scheduled', 'archived']),
  ],
  sortable: ['title', 'publishedAt', 'createdAt'],
  defaultSort: { field: 'publishedAt', direction: 'desc' },
  bulkActions: [
    { action: 'publish', label: 'Publish', requires: 'edit', set: { status: 'published' } },
    { action: 'archive', label: 'Archive', requires: 'delete', set: { status: 'archived' }, destructive: true },
  ],
  enrich: enrichBlogs,
});

const menusResource = defineResource({
  slug: 'menus',
  title: 'Navigation Menus',
  description: 'Header, footer, and mobile navigation structure.',
  group: 'Content & Storefront',
  module: 'content',
  name: { singular: 'Menu', plural: 'Menus' },
  tag: 'Admin content',
  table: menus,
  primaryKey: menus.id,
  columns: {
    id: menus.id,
    key: menus.key,
    name: menus.name,
    createdAt: menus.createdAt,
    updatedAt: menus.updatedAt,
  },
  listColumns: ['name', 'key'],
  fields: [
    { key: 'name', label: 'Menu Name', kind: 'text', required: true, max: 120 },
    { key: 'key', label: 'Identifier Key', kind: 'text', required: true, max: 120 },
  ],
  searchable: ['name', 'key'],
  filterable: [],
  sortable: ['name', 'key', 'createdAt'],
  defaultSort: { field: 'name', direction: 'asc' },
  bulkActions: [],
  enrich: enrichMenus,
});

const mediaLibraryResource = defineResource({
  slug: 'media',
  title: 'Media Library',
  description: 'Product photography, banners, and video assets.',
  group: 'Content & Storefront',
  module: 'content',
  name: { singular: 'Media Asset', plural: 'Media Assets' },
  tag: 'Admin content',
  table: mediaAssets,
  primaryKey: mediaAssets.id,
  columns: {
    id: mediaAssets.id,
    filename: mediaAssets.filename,
    contentType: mediaAssets.contentType,
    sizeBytes: mediaAssets.sizeBytes,
    width: mediaAssets.width,
    height: mediaAssets.height,
    url: mediaAssets.url,
    altText: mediaAssets.altText,
    createdAt: mediaAssets.createdAt,
    updatedAt: mediaAssets.updatedAt,
  },
  listColumns: ['filename', 'contentType', 'sizeBytes'],
  fields: [
    { key: 'filename', label: 'Filename', kind: 'text', required: true, max: 255 },
    { key: 'contentType', label: 'MIME Type', kind: 'text', required: true, max: 120 },
    { key: 'url', label: 'URL', kind: 'text', required: true },
    { key: 'altText', label: 'Alt Text', kind: 'text', required: false, max: 255 },
  ],
  searchable: ['filename', 'altText'],
  filterable: [],
  sortable: ['filename', 'sizeBytes', 'createdAt'],
  defaultSort: { field: 'createdAt', direction: 'desc' },
  bulkActions: [],
  enrich: enrichMediaLibrary,
});

`;

if (!content.includes('blogPostsResource')) {
  content = content.replace(
    'export const RESOURCES: readonly ResourceDescriptor[] = [',
    resourcesString + '\nexport const RESOURCES: readonly ResourceDescriptor[] = ['
  );
  
  content = content.replace(
    '  seoEntriesResource,\n]',
    '  seoEntriesResource,\n  blogPostsResource,\n  menusResource,\n  mediaLibraryResource,\n]'
  );
}

fs.writeFileSync(path, content, 'utf8');
console.log('Successfully updated resource.registry.ts');
