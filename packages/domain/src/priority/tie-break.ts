// TR-PRIORITY-13 / EC-05 — deterministic tie-breaking for identical
// (tier, priorityScore) pairs.
//
// Rule:
//   1. Oldest `mostRecentSuccessfulContactAt` first (ascending date).
//      A null contact date means "no successful contact on record", which
//      per TR-PRIORITY-14 is treated as the maximum days-since value —
//      i.e., the oldest of all — and therefore wins the tie.
//   2. Participant ID ascending (string comparison). Participant IDs are
//      unique, so this leg always terminates the comparison.
//
// Scope: this comparator assumes callers have already grouped rows by
// tier and ordered by priorityScore (TR-PRIORITY-7/12). It only resolves
// what to do when score+tier are equal. Building the full queue sort
// (tier desc → score desc → tie-break) is a separate concern.
//
// Pure: no I/O, no mutation. Deterministic per TR-PRIORITY-13 / EC-05 —
// same input rows → same final order, every run.

export interface RankableParticipant {
  readonly participantId: string;
  readonly mostRecentSuccessfulContactAt: Date | null;
}

export function compareTieBreak(
  a: RankableParticipant,
  b: RankableParticipant,
): -1 | 0 | 1 {
  const dateCmp = compareContactAscending(
    a.mostRecentSuccessfulContactAt,
    b.mostRecentSuccessfulContactAt,
  );
  if (dateCmp !== 0) return dateCmp;

  if (a.participantId < b.participantId) return -1;
  if (a.participantId > b.participantId) return 1;
  return 0;
}

// null sorts before any concrete date (null = oldest, per TR-PRIORITY-14).
// Two nulls compare equal; the participant-ID leg resolves it.
function compareContactAscending(
  a: Date | null,
  b: Date | null,
): -1 | 0 | 1 {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const at = a.getTime();
  const bt = b.getTime();
  if (at < bt) return -1;
  if (at > bt) return 1;
  return 0;
}
