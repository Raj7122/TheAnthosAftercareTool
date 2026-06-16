"use client";

import type {
  CaseloadOpenBarrier,
  CaseloadStabilityVisit,
  ParticipantRecentContact,
} from "@anthos/api";

import { RecentContactsTimeline } from "../../participants/[id]/_components/RecentContactsTimeline";
import { useParticipantComms } from "./ParticipantCommsProvider";

// P1H-11 (demo) — client wrapper that feeds this session's optimistic sends
// from `ParticipantCommsProvider` into the otherwise-presentational
// `RecentContactsTimeline`. Keeps the timeline free of context coupling so it
// stays trivially testable with plain props. P3D-01 threads through the opened
// barriers + next-visit-due so the timeline subsumes the removed month-grid
// calendar.
interface Props {
  readonly recentContacts: ReadonlyArray<ParticipantRecentContact>;
  readonly openBarriers: ReadonlyArray<CaseloadOpenBarrier>;
  readonly stabilityVisit: CaseloadStabilityVisit;
}

export function RecentContactsTimelineLive({
  recentContacts,
  openBarriers,
  stabilityVisit,
}: Props) {
  const { optimisticSends, optimisticRepairs, optimisticCaseNotes } =
    useParticipantComms();
  return (
    <RecentContactsTimeline
      recentContacts={recentContacts}
      optimisticSends={optimisticSends}
      repairs={optimisticRepairs}
      caseNotes={optimisticCaseNotes}
      openBarriers={openBarriers}
      stabilityVisit={stabilityVisit}
    />
  );
}
