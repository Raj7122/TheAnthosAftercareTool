// Display formatters for breakdown payload (API v1.3 §7.3.1).
// Engine emits formatted strings; BFF passes them through to the UI.

export function formatWeight(rawWeight: number): string {
  // API shape shows "1.5×" / "4.0×" — one decimal, multiplication sign suffix.
  return `${rawWeight.toFixed(1)}×`;
}
