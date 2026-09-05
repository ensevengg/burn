/**
 * Theme (grey-dark accent per user direction): near-monochrome greys, no
 * loud accent hue — hierarchy comes from contrast and weight. Semantic
 * colors (ok/warn/err) survive only where meaning demands them.
 * All theme-dependent colors come from the ThemeProvider at runtime; never
 * import a palette directly in screens.
 */

export interface ThemeColors {
  bg: string;
  panel: string;
  panelAlt: string;
  border: string;
  text: string;
  muted: string;
  faint: string;
  /** Primary accent — grey-dark in dark mode, near-black in light mode. */
  accent: string;
  /** Ink to place on top of accent fills. */
  accentInk: string;
  ok: string;
  warn: string;
  err: string;
  /** Descending-contrast series colors for stacked charts. */
  chart: string[];
  statusBar: "light-content" | "dark-content";
}

export const darkColors: ThemeColors = {
  bg: "#0c0d10",
  panel: "#15171b",
  panelAlt: "#1d2025",
  border: "#262a31",
  text: "#e8eaed",
  muted: "#9aa0a8",
  faint: "#565b63",
  accent: "#e8eaed",
  accentInk: "#0c0d10",
  ok: "#7ee787",
  warn: "#f3c969",
  err: "#ff8d8d",
  chart: ["#e8eaed", "#a6acb4", "#787e87", "#565b63", "#3c4047", "#2b2e34"],
  statusBar: "light-content",
};

export const lightColors: ThemeColors = {
  bg: "#f5f6f7",
  panel: "#ffffff",
  panelAlt: "#eceef0",
  border: "#d9dcdf",
  text: "#17181a",
  muted: "#6b7076",
  faint: "#a3a8ae",
  accent: "#17181a",
  accentInk: "#ffffff",
  ok: "#1a7f37",
  warn: "#9a6700",
  err: "#cf222e",
  chart: ["#17181a", "#4a4e54", "#6b7076", "#8b9096", "#aab0b6", "#c8ccd0"],
  statusBar: "dark-content",
};

export const spacing = { xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 32 };

/** Typography without color — color always comes from the theme. */
export const type = {
  title: { fontSize: 28, fontWeight: "700" as const },
  headline: { fontSize: 40, fontWeight: "700" as const },
  h2: { fontSize: 17, fontWeight: "600" as const },
  body: { fontSize: 14 },
  muted: { fontSize: 12.5 },
  stat: { fontSize: 21, fontWeight: "700" as const, fontVariant: ["tabular-nums" as const] },
  mono: { fontSize: 12, fontVariant: ["tabular-nums" as const] },
};
