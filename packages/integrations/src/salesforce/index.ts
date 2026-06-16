export { SfCliKeychainAuth } from "./auth.js";
export type { SfCliKeychainAuthOptions } from "./auth.js";
export { SalesforceConnectedAppAuth } from "./connected-app-auth.js";
export type { SalesforceConnectedAppAuthOptions } from "./connected-app-auth.js";
export { exchangeAuthorizationCode } from "./authorization-code.js";
export type {
  AuthorizationCodeExchangeInput,
  AuthorizationCodeExchangeOptions,
  TokenExchangeResult,
} from "./authorization-code.js";
export { exchangeRefreshToken } from "./refresh-token.js";
export type {
  RefreshTokenExchangeInput,
  RefreshTokenExchangeOptions,
  RefreshTokenExchangeResult,
} from "./refresh-token.js";
export {
  RoleResolutionError,
  parseSalesforceUserId,
  resolveRoleFromPermissionSet,
} from "./permission-set-role.js";
export type {
  RoleResolutionFailureReason,
  SoqlQueryClient,
} from "./permission-set-role.js";
export { fetchSalesforceUserIdentity } from "./user-identity.js";
export type { SalesforceUserIdentity } from "./user-identity.js";
export { listSpecialists } from "./list-specialists.js";
export type { SalesforceSpecialist } from "./list-specialists.js";
export { hydrateCaseload } from "./bulk-hydration.js";
export {
  queryCaseloadActivityRecords,
  queryOwnedEnrollments,
} from "./activity-queries.js";
export type {
  CaseloadActivityQueryArgs,
  CaseloadActivityRecords,
  CaseNoteActivityRecord,
  OwnedEnrollment,
  SmsActivityRecord,
} from "./activity-queries.js";
export {
  KNOWN_BARRIER_TYPES,
  getKnownBarrierTypes,
  getKnownBarrierTypesOrdered,
} from "./picklist-cache.js";
export { SalesforceRestClient } from "./rest-client.js";
export type {
  CompositeBatchResponse,
  CompositeSubResponse,
  CreateRecordResult,
  FlowInvocationResult,
  RestClientOptions,
  SoqlQueryResponse,
} from "./rest-client.js";
export { DEFAULT_POLL_LIMIT, pollObjectChanges } from "./cdc-poll.js";
export type {
  CdcChangeRecord,
  PollObjectChangesInput,
  PollObjectChangesResult,
} from "./cdc-poll.js";
export { assertSalesforceId, buildIdInClause, escapeSoqlString } from "./soql.js";
export {
  SalesforceError,
  type AftercareDueDates,
  type ArrearSnapshot,
  type BarrierSnapshot,
  type BulkHydrationOptions,
  type BulkHydrationResult,
  type CaseloadSnapshot,
  type EnrollmentSnapshot,
  type IncidentSnapshot,
  type SalesforceAuth,
  type SalesforceErrorCode,
} from "./types.js";
