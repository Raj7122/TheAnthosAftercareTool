export { handleSendSms } from "./create-sms.js";
export type {
  SendSmsHandlerOptions,
  RouteContext as SendSmsRouteContext,
} from "./create-sms.js";
export { SMS_BODY_MAX_LEN, sendSmsRequestSchema } from "./dto.js";
export type {
  SendSmsRequest,
  SendSmsResponseBody,
  SmsDeliveryStatus,
} from "./dto.js";
// Intentional non-export: `PriorityRecomputed` / `PriorityRecomputedFactor`
// already ride out of `barriers/index.ts` with identical shape — re-exporting
// here would collide on the `@anthos/api` barrel (same posture as case-notes).
