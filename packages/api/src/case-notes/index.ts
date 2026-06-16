export { handleLogCall } from "./create-call.js";
export { handleCreateCaseNote } from "./create-case-note.js";
export type {
  CreateCaseNoteHandlerOptions,
  CaseNoteRouteContext,
} from "./create-case-note.js";
// NOTE: the picklist enums/consts (CASE_NOTE_* / CaseNote*Type) are
// intentionally NOT re-exported here — `participants/case-notes-dto.ts` (the
// E-09 read DTO) already owns `CaseNoteContactType` / `CASE_NOTE_CONTACT_TYPES`
// on the `@anthos/api` barrel, so re-exporting would collide. The create
// handler uses them internally; tests import them from the dto file directly;
// the client sheet hardcodes its dropdown options (bundle discipline).
export { createCaseNoteRequestSchema } from "./create-case-note-dto.js";
export type {
  CreateCaseNoteRequest,
  CreateCaseNoteResponseBody,
} from "./create-case-note-dto.js";
export type {
  CaseNoteWriteArgs,
  CaseNoteWriteFn,
  CaseNoteWriteResult,
  LogCallHandlerOptions,
  RouteContext as LogCallRouteContext,
} from "./create-call.js";
export {
  LOG_CALL_STATUSES,
  LOG_CALL_TYPES,
  logCallRequestSchema,
  SCHEMA_GAP_NO_CASE_NOTE_WRITE_TARGET,
  SERVICE_DATE_BACKDATE_DAYS,
  SERVICE_DATE_FORWARD_DAYS,
  STUB_CASE_NOTE_ID_PREFIX,
} from "./dto.js";
export type {
  LogCallContactType,
  LogCallRequest,
  LogCallResponseBody,
  LogCallSource,
  LogCallStatus,
  LogCallType,
} from "./dto.js";
// Intentional non-export: `PriorityRecomputed` and `PriorityRecomputedFactor`
// already ride out of `barriers/index.ts` with identical shape (mirroring
// API §7.4.3 / §7.4.8). Re-exporting them here would collide on the
// `@anthos/api` barrel — keep them implementation-detail to the case-notes
// dto and let downstream consumers import from `barriers` if they need a
// named type. The wire shape on `LogCallResponseBody.priorityRecomputed`
// matches by construction.
