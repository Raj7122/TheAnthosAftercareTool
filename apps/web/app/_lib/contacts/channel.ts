// Contact-channel helpers for the host surfaces. The classifier itself now
// lives in @anthos/domain (pure, shared with the caseload activity BFF so the
// server and client map channels identically); this module re-exports it so the
// existing web import paths (Recent Contacts timeline, activity calendar) keep
// working, and keeps the presentation-only glyph here.

export {
  classifyContactChannel,
  type ContactChannelKind,
} from "@anthos/domain";

import type { ContactChannelKind } from "@anthos/domain";

export function channelGlyph(kind: ContactChannelKind): string {
  switch (kind) {
    case "sms":
      return "💬";
    case "email":
      return "✉️";
    case "visit":
      return "🤝";
    case "phone":
      return "📞";
  }
}
