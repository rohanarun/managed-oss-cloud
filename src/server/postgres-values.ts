export function databaseTimestampIso(value: unknown, fieldName = "database timestamp") {
  const parsed = value instanceof Date
    ? value
    : typeof value === "string" || typeof value === "number"
      ? new Date(value)
      : new Date(Number.NaN);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${fieldName} is missing or invalid.`);
  return parsed.toISOString();
}
