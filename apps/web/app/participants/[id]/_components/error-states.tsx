import { BackToCaseloadLink } from "./BackToCaseloadLink";

interface Props {
  readonly traceId: string | null;
}

// 404 for E-08. The endpoint also returns 404 when the SF record exists but
// SOQL FLS denied the read (response.ts maps both to RESOURCE_NOT_FOUND so
// the SPA cannot back-channel "you don't have access"). The branded copy
// stays neutral about cause.
export function ParticipantNotFoundState({ traceId }: Props) {
  return (
    <ErrorShell
      heading="Participant not found"
      body="This participant isn't available. Check the link or return to your caseload."
      traceId={traceId}
    />
  );
}

export function NotInCaseloadState({ traceId }: Props) {
  return (
    <ErrorShell
      heading="Not in your caseload"
      body="VR-15 keeps detail views scoped to caseloads you own. If you think this is wrong, ask your supervisor to confirm caseload assignment."
      traceId={traceId}
    />
  );
}

export function ServiceUnavailableState({ traceId }: Props) {
  return (
    <ErrorShell
      heading="Salesforce is temporarily unavailable"
      body="The system of record didn't respond. Try again in a moment."
      traceId={traceId}
    />
  );
}

export function SomethingWentWrongState({ traceId }: Props) {
  return (
    <ErrorShell
      heading="Something went wrong"
      body="An unexpected error occurred. If this persists, share the trace ID with engineering."
      traceId={traceId}
    />
  );
}

function ErrorShell({
  heading,
  body,
  traceId,
}: {
  readonly heading: string;
  readonly body: string;
  readonly traceId: string | null;
}) {
  return (
    <section className="mx-auto max-w-md space-y-4 rounded-lg border bg-card p-6 shadow-sm">
      <h2 className="text-lg font-semibold">{heading}</h2>
      <p className="text-sm text-muted-foreground">{body}</p>
      {traceId !== null && (
        <p className="text-xs text-muted-foreground">
          Trace ID: <span className="font-mono">{traceId}</span>
        </p>
      )}
      <BackToCaseloadLink variant="outline" className="h-11">
        Back to caseload
      </BackToCaseloadLink>
    </section>
  );
}
