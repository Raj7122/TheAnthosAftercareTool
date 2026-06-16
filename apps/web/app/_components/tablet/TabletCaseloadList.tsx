import type { CaseloadItem, CaseloadOpenBarrier } from "@anthos/api";

import { queueEmptyState } from "../../caseload/_lib/queue-empty-states";
import { TabletCaseloadRow } from "./TabletCaseloadRow";

interface Props {
  readonly items: ReadonlyArray<CaseloadItem>;
  readonly queueId: string;
  readonly canMutateBarriers: boolean;
  readonly canMutateRepairs: boolean;
  readonly canLogCaseNotes: boolean;
  readonly canLogCalls: boolean;
  readonly pendingParticipantIds: ReadonlySet<string>;
  readonly changedParticipantIds: ReadonlySet<string>;
  readonly onAddRepair: (participantId: string) => void;
  readonly onLogCaseNote: (participantId: string) => void;
  readonly onLogCall: (participantId: string) => void;
  readonly onCloseBarrier: (
    participantId: string,
    barrier: CaseloadOpenBarrier,
  ) => void;
}

// P3B-03 — tablet caseload list shell. Same prop bag as `CaseloadList` so the
// `CaseloadView` switch is a one-line ternary; the divergence is purely
// presentational: `<ul>` of card rows instead of the 7-column `<table>`.
// The empty-state copy reuses `queueEmptyState(queueId)` so VR-09 surfaces
// the same friendly text across variants.
export function TabletCaseloadList({
  items,
  queueId,
  canMutateBarriers,
  canMutateRepairs,
  canLogCaseNotes,
  canLogCalls,
  pendingParticipantIds,
  changedParticipantIds,
  onAddRepair,
  onLogCaseNote,
  onLogCall,
  onCloseBarrier,
}: Props) {
  if (items.length === 0) {
    return (
      <p
        className="rounded-2xl border border-zinc-100/60 px-4 py-10 text-center text-sm text-muted-foreground"
        data-testid="caseload-empty"
      >
        {queueEmptyState(queueId)}
      </p>
    );
  }
  return (
    <ul
      className="flex flex-col gap-3"
      data-testid="caseload-list"
      data-variant="tablet"
    >
      {items.map((item) => (
        <TabletCaseloadRow
          key={item.participantId}
          item={item}
          canMutateBarriers={canMutateBarriers}
          canMutateRepairs={canMutateRepairs}
          canLogCaseNotes={canLogCaseNotes}
          canLogCalls={canLogCalls}
          isSaving={pendingParticipantIds.has(item.participantId)}
          isChanged={changedParticipantIds.has(item.participantId)}
          onAddRepair={onAddRepair}
          onLogCaseNote={onLogCaseNote}
          onLogCall={onLogCall}
          onCloseBarrier={onCloseBarrier}
        />
      ))}
    </ul>
  );
}
