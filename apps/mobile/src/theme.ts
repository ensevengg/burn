/**
 * Graphite theme: AMOLED-black canvas, raised graphite surfaces, monochrome
 * data ink. Per user direction there is no loud accent hue — hierarchy comes
 * from luminance, weight and space. Semantic colors (live/stale/critical)
 * appear only where meaning demands them.
 * All theme-dependent colors come from the ThemeProvider at runtime; never
 * import a palette directly in screens.
 */
import { StyleSheet } from "react-native";

export interface ThemeColors {
  bg: string;
  panel: string;
  panelAlt: string;
  border: string;
  text: string;
  muted: string;
  faint: string;
  /** Primary accent — near-white in dark mode, near-black in light mode. */
  accent: string;
  /** Ink to place on top of accent fills. */
  accentInk: string;
  ok: string;
  warn: string;
  err: string;
  /** Descending-contrast series colors for stacked charts and share bars. */
  chart: string[];
  /** Floating chrome (tab bar, compact header): opaque enough to read over content. */
  chrome: string;
  /** Selected segment / tab highlight. */
  selection: string;
  statusBar: "light-content" | "dark-content";
}

export const darkColors: ThemeColors = {
  bg: "#000000",
  panel: "#0e0f11",
  panelAlt: "#17191c",
  border: "#23262b",
  text: "#f3f4f6",
  muted: "#8d939b",
  faint: "#50555d",
  accent: "#f3f4f6",
  accentInk: "#000000",
  ok: "#4fe0a0",
  warn: "#f2c25b",
  err: "#ff7b7b",
  chart: ["#f3f4f6", "#b3b8bf", "#868c95", "#626870", "#454a51", "#30343a"],
  chrome: "#131417",
  selection: "#26292e",
  statusBar: "light-content",
};

export const lightColors: ThemeColors = {
  bg: "#f3f4f6",
  panel: "#ffffff",
  panelAlt: "#eceef1",
  border: "#e0e3e7",
  text: "#0d0e10",
  muted: "#666c75",
  faint: "#a5aab1",
  accent: "#0d0e10",
  accentInk: "#ffffff",
  ok: "#12a066",
  warn: "#b07a12",
  err: "#d63c3c",
  chart: ["#0d0e10", "#43474d", "#6a7078", "#8d939a", "#b0b5bb", "#cfd3d7"],
  chrome: "#ffffff",
  selection: "#ffffff",
  statusBar: "dark-content",
};

export const spacing = { xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 32 };
/** Screen gutter. */
export const gutter = 20;
export const radius = { s: 10, m: 16, l: 22, pill: 999 };
export const hairline = StyleSheet.hairlineWidth;

/** Typography without color — color always comes from the theme. */
export const type = {
  display: {
    fontSize: 46,
    fontWeight: "700" as const,
    letterSpacing: -1.8,
    fontVariant: ["tabular-nums" as const],
    includeFontPadding: false,
  },
  title: { fontSize: 32, fontWeight: "700" as const, letterSpacing: -0.9, includeFontPadding: false },
  headline: { fontSize: 40, fontWeight: "700" as const },
  h2: { fontSize: 16, fontWeight: "600" as const, letterSpacing: -0.2 },
  eyebrow: { fontSize: 11.5, fontWeight: "600" as const, letterSpacing: 0.9, textTransform: "uppercase" as const },
  body: { fontSize: 14.5 },
  muted: { fontSize: 12.5 },
  stat: { fontSize: 20, fontWeight: "700" as const, letterSpacing: -0.4, fontVariant: ["tabular-nums" as const] },
  mono: { fontSize: 12, fontVariant: ["tabular-nums" as const] },
};

/** Motion tokens. Springs settle without visible bounce; durations stay under 450ms. */
export const motion = {
  fast: 160,
  base: 260,
  slow: 420,
  snappy: { stiffness: 420, damping: 36, mass: 1 },
  gentle: { stiffness: 220, damping: 26, mass: 1 },
};
