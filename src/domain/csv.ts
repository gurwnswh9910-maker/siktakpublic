export function csvCell(value: unknown) {
  const text = String(value ?? "");
  const safe = /^[\s]*[=+@\-\t\r\n]/.test(text) ? "'" + text : text;
  return '"' + safe.replaceAll('"', '""') + '"';
}
