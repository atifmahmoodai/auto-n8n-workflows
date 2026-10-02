/** Replaces {placeholder} tokens; unknown placeholders are left untouched so typos are visible. */
export function renderTemplate(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template
    .replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? String(vars[key] ?? '') : match))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

export const TEMPLATE_PLACEHOLDERS = [
  'customer_name',
  'customer_first_name',
  'business_name',
  'business_phone',
  'service',
  'vehicle',
  'date',
  'time',
  'datetime',
  'location',
  'review_link',
  'offer',
] as const;
