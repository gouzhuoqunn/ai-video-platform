export function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export function safeFixed(value: unknown, digits = 2) {
  const number = finiteNumber(value);
  return number === null ? "—" : number.toFixed(digits);
}

export function formatHourlyPrice(value: unknown) {
  const fixed = safeFixed(value, 2);
  return fixed === "—" ? "$—/小时" : `$${fixed}/小时`;
}
