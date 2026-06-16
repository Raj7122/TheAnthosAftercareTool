import { Badge } from "@/components/ui/badge";

// Optional data envelope. When the GAP-17 voucher schema lands, the page
// will pass a populated `voucher` prop and the card flips from stub to live
// rendering with no other changes.
export interface VoucherSubsidy {
  readonly type: string | null;
  readonly recertDueDate: string | null;
  readonly daysUntilRecert: number | null;
}

interface Props {
  readonly voucher?: VoucherSubsidy | undefined;
}

// F-07 wireframe voucher / subsidy card. Open GAP-17: the SF voucher-recert
// field schema is not confirmed — Erik OOO 2026-05. Until the schema lands,
// the card renders a labeled shell with `—` placeholders and a "pending
// data source" banner so the specialist sees the slot but doesn't trust
// it. Once GAP-17 closes, the page passes a populated `voucher` object and
// the card flips to live rendering. No spec divergence introduced.
export function VoucherSubsidyCard({ voucher }: Props) {
  const isStub = voucher === undefined;
  return (
    <section
      aria-labelledby="voucher-subsidy-heading"
      className="rounded-lg border bg-card p-4 shadow-sm"
    >
      <div className="flex items-center justify-between gap-2">
        <h2
          id="voucher-subsidy-heading"
          className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Voucher & subsidy
        </h2>
        <Badge variant="info">New</Badge>
      </div>
      <dl className="mt-3 space-y-2 text-sm">
        <Row label="Voucher type" value={voucher?.type ?? "—"} />
        <Row
          label="Recertification due"
          value={voucher?.recertDueDate ?? "—"}
        />
      </dl>
      {voucher?.daysUntilRecert !== undefined &&
        voucher.daysUntilRecert !== null && (
          <div className="mt-3 rounded-md border bg-muted/30 p-3 text-center">
            <div className="text-3xl font-semibold tabular-nums">
              {voucher.daysUntilRecert}
            </div>
            <div className="text-xs text-muted-foreground">
              days until recertification
            </div>
          </div>
        )}
      {isStub && (
        <p role="note" className="mt-3 text-xs text-muted-foreground">
          Voucher details aren&rsquo;t available yet.
        </p>
      )}
    </section>
  );
}

function Row({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
