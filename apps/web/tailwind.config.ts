import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "1rem",
    },
    extend: {
      colors: {
        border: "hsl(220 13% 91%)",
        input: "hsl(220 13% 91%)",
        ring: "hsl(220 13% 50%)",
        background: "hsl(0 0% 100%)",
        foreground: "hsl(220 13% 18%)",
        muted: {
          DEFAULT: "hsl(220 13% 96%)",
          foreground: "hsl(220 9% 46%)",
        },
        primary: {
          DEFAULT: "hsl(220 13% 18%)",
          foreground: "hsl(0 0% 100%)",
        },
        destructive: {
          DEFAULT: "hsl(0 84% 60%)",
          foreground: "hsl(0 0% 100%)",
        },
        tier1: "hsl(0 84% 60%)",
        tier2: "hsl(38 92% 50%)",
        tier3: "hsl(142 71% 45%)",
        // F-05 cycle-status palette (BR-33 five-state visualization).
        // Green / orange / red / purple per FS_v1_12 §F-05.
        cycleComplete: "hsl(142 71% 45%)",
        cycleDue: "hsl(38 92% 50%)",
        cycleOverdue: "hsl(0 84% 60%)",
        cycleCatchUp: "hsl(280 65% 55%)",
        // F-06 BR-38 severity-tier badge palette [INFERRED — UX to validate
        // for accessibility]. WCAG AA 4.5:1 against white at darker shades:
        // red-700, amber-700, slate-500 for unclassified low-severity.
        barrierHigh: "hsl(0 72% 40%)",
        barrierMedium: "hsl(32 85% 38%)",
        barrierLow: "hsl(215 16% 47%)",
        // P1H-03 / P1H-05 tag chip "info" severity (neutral context signals
        // like aftercare_extended). Indigo-800 matches the wireframe
        // `.badge-tag` palette (#3730a3) at WCAG AA against white.
        tagInfo: "hsl(231 48% 48%)",
        // F-13 tablet field-card palette. Tokens ported verbatim from the
        // mockup CSS the user supplied. Grouped under `tablet*` so config
        // intent stays legible.
        tabletPrimary: "#1d2a4a",
        tabletPrimaryDeep: "#0f1729",
        tabletAccent: "#ffd166",
        tabletPending: "#fbbf24",
        tabletPendingBg: "#fffbeb",
        tabletReview: "#7c3aed",
        tabletReviewBg: "#f5f3ff",
      },
      borderRadius: {
        md: "0.5rem",
        sm: "0.375rem",
      },
    },
  },
  plugins: [],
};

export default config;
