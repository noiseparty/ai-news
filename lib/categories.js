'use strict';

/** Fixed set of categories. Order here is the order sections appear on the front page. */
const CATEGORIES = [
  { id: 'general-ai', label: 'General AI' },
  { id: 'models', label: 'Models' },
  { id: 'science', label: 'Science' },
  { id: 'methods', label: 'Methods' },
  { id: 'workflows', label: 'Workflows' },
  { id: 'websites', label: 'Websites' },
];

const DEFAULT_CATEGORY = 'general-ai';
const byId = new Map(CATEGORIES.map((c) => [c.id, c]));

const isCategory = (id) => byId.has(id);
const categoryLabel = (id) => byId.get(id)?.label ?? byId.get(DEFAULT_CATEGORY).label;

module.exports = { CATEGORIES, DEFAULT_CATEGORY, isCategory, categoryLabel };
