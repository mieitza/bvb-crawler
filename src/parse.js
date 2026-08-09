// Parse a Romanian-formatted number like "1.4100" (thousands are dot, decimal is comma)
// e.g. "18.376.590,63" -> 18376590.63 ; "0,6790" -> 0.6790
export function roNumber(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/\s/g, '').replace(/[^\d,.-]/g, '');
  if (!s) return null;
  // If both . and , present, dots are thousands separators.
  if (s.includes('.') && s.includes(',')) {
    return parseFloat(s.replace(/\./g, '').replace(',', '.'));
  }
  // If only comma present, it's the decimal separator.
  if (s.includes(',')) return parseFloat(s.replace(',', '.'));
  return parseFloat(s);
}

// Parse "19.11.2025 12:36:30" (DD.MM.YYYY HH:mm:ss) -> ISO
export function roDate(raw) {
  if (!raw) return null;
  const m = raw.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const [, d, mo, y, h = '0', mi = '0', se = '0'] = m;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se));
  return isNaN(dt.getTime()) ? null : dt.toISOString();
}

export function parseDateOnly(raw) {
  const iso = roDate(raw);
  return iso ? iso.slice(0, 10) : null;
}

// Strip the label from a "Label value" cell, returning the trimmed value text.
export function cellValue(el) {
  if (!el) return null;
  return el.textContent.replace(/\s+/g, ' ').trim();
}

// Given a row containing label and value, extract the value portion.
// BVB renders pairs as: <td>Label</td><td>value</td> or within a single cell.
export function pairValue(root, label) {
  if (!root) return null;
  const txt = root.textContent;
  // Match "Label value" where value starts after the label text.
  const re = new RegExp(escapeRegExp(label) + '\\s*([^\\n]+)', 'i');
  const m = txt.match(re);
  return m ? m[1].trim() : null;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}