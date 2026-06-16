// F-07 loading skeleton. AC-26 budget is <2s for the full render; the
// skeleton fills the time between the initial route hit and the server
// component resolving so the page doesn't flash blank. Pure presentational,
// no client hooks — Next.js mounts it automatically on the route transition.
export default function ParticipantDetailLoading() {
  return (
    <main
      aria-busy="true"
      aria-label="Loading participant detail"
      className="container mx-auto max-w-5xl space-y-4 py-6"
    >
      <div className="h-14 animate-pulse rounded-lg border bg-card" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="h-44 animate-pulse rounded-lg border bg-card" />
        <div className="h-44 animate-pulse rounded-lg border bg-card" />
      </div>
      <div className="h-24 animate-pulse rounded-lg border bg-card" />
      <div className="h-32 animate-pulse rounded-lg border bg-card" />
    </main>
  );
}
