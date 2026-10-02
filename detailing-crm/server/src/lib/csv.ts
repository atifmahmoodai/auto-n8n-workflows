/**
 * RFC 4180 CSV with spreadsheet formula-injection protection: cells starting with = + - @ (or tab/CR)
 * are prefixed with a quote so Excel/Sheets show them as text instead of executing them.
 */
export function toCsv(headers: string[], rows: Array<Array<string | number | boolean | null | undefined>>): string {
  const cell = (v: string | number | boolean | null | undefined): string => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))];
  // BOM so Excel opens UTF-8 (names with accents, £) correctly.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
