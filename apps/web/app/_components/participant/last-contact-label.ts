// P1H-05 — "Last contact" caseload-row cell. Pure projection of the wire
// field `CaseloadItem.lastSuccessfulContactDaysAgo` into the wireframe's
// compact "Nd" form. The DTO carries the integer (snapshot-derived from
// `Most_Recent_Successful_Contact__c`); the UI owns the display token.
//
// `null` → "—" so a row that has never been successfully reached doesn't
// fall back to "0d" (which would imply contact today).
export function lastContactLabel(daysAgo: number | null): string {
  if (daysAgo === null) return "—";
  return `${daysAgo}d`;
}
