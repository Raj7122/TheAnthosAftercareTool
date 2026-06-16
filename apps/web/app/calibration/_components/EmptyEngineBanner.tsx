export function EmptyEngineBanner() {
  return (
    <div
      role="status"
      className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      <strong className="font-semibold">Priority engine not yet wired.</strong>{" "}
      Awaiting P0-04 (factors a–i) and P0-04a/b/c (categorical Tier-1
      invariants + breakdown payload). Showing hydrated participants without
      scores. Rows will surface tier, score, and per-factor breakdown
      automatically once those tickets merge.
    </div>
  );
}
