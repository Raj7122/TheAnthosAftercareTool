// Participant-scoped public surface — the handlers plus the wire-DTO types
// the SPA binds to. Internal helpers (identity hydration, response factories,
// DTO builders, cursor codec) are imported within @anthos/api directly rather
// than re-exported.
//
// Endpoints: E-08 (`GET /participants/:id`, F-07 detail), E-09
// (`GET /participants/:id/case-notes`, F-07 paginated history), and the
// P1H-10 Path C un-suppress stub (`DELETE /participants/:id/suppression`,
// not yet specced — flag-gated, returns 404 until BR-21 ratifies).

export { handleGetParticipant } from "./get-participant.js";
export type { GetParticipantHandlerOptions } from "./get-participant.js";
export { handleGetCaseNotes } from "./get-case-notes.js";
export type { GetCaseNotesHandlerOptions } from "./get-case-notes.js";
export { handleUnSuppress } from "./un-suppress.js";
export type {
  UnSuppressHandlerOptions,
  UnSuppressRouteContext,
} from "./un-suppress.js";
export type {
  CommunicationConsent,
  ParticipantAddress,
  ParticipantContact,
  ParticipantDetailBody,
  ParticipantRecentContact,
  PreferredContactMethod,
  QuickActionDisabledReason,
  QuickActionState,
  QuickActions,
} from "./dto.js";
export type {
  CaseNoteContactType,
  CaseNoteItem,
  CaseNoteSource,
  CaseNotesPage,
  CaseNotesPageBody,
} from "./case-notes-dto.js";
