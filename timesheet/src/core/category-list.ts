import type { Category } from './config.ts';

/**
 * Reads a pasted task list: one category per line, columns separated by tabs (a spreadsheet
 * copy), `|` or `;`: name, subtask, description, CAPEX/OPEX. Only the name is required. A header
 * row and repeated names are skipped. A JSON array of categories (an exported list) works too.
 */
export function parseCategoryList(text: string): Category[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    const list = JSON.parse(trimmed) as unknown[];
    if (!Array.isArray(list)) throw new Error('expected a JSON array of categories');
    return dedupe(list.map((x) => (typeof x === 'string' ? { name: x } : (x as Partial<Category>))).map((x) => ({ ...x, name: String(x.name ?? '').trim(), subtask: x.subtask ?? '', description: x.description ?? '', capex: !!x.capex })));
  }
  const rows = trimmed
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''))
    .filter((line) => line.trim())
    .map((line) => line.split(line.includes('\t') ? '\t' : line.includes('|') ? '|' : ';').map((cell) => cell.trim()));
  if (rows.length && /^(name|task( category)?|category|categories)$/i.test(rows[0][0])) rows.shift();
  return dedupe(rows.map(([name = '', subtask = '', description = '', accounting = '']) => ({ name, subtask, description, capex: /^(capex|capitali[sz]ed|yes|true|y|x|1)$/i.test(accounting) })));
}

function dedupe(list: Category[]): Category[] {
  const seen = new Set<string>();
  return list.filter((c) => c.name && !seen.has(c.name) && seen.add(c.name));
}

/** Pasted categories merged into the configured ones: existing names keep their settings, new ones are added at the end. */
export function mergeCategories(current: Category[], pasted: Category[]): Category[] {
  const names = new Set(current.map((c) => c.name));
  return [...current, ...pasted.filter((c) => !names.has(c.name))];
}
