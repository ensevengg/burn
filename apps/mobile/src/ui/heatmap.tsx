/**
 * GitHub-style contribution grid: columns = weeks, rows = weekdays, cell
 * intensity = daily tokens. Monochrome intensity scale; tap a cell to see
 * that day below. Pure display — day keys arrive pre-bucketed in the
 * reporting timezone (D8).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../lib/theme-context";
import { spacing } from "../theme";
import { bucketKey, formatCost, formatTokens } from "../lib/format";
import type { DailyTotals } from "../data/repository";

const DAY_MS = 86_400_000;
const CELL = 13;
const GAP = 2.5;

function intensity(tokens: number, max: number, C: { panelAlt: string; text: string }): string {
  // Monotonic brightness on the dark card: empty cells stay faint, data cells
  // brighten with intensity (empty-brighter-than-filled was the visual bug).
  if (tokens <= 0 || max <= 0) return withAlpha(C.text, 0.06);
  const fraction = tokens / max;
  if (fraction > 0.6) return C.text;
  if (fraction > 0.3) return withAlpha(C.text, 0.7);
  if (fraction > 0.1) return withAlpha(C.text, 0.45);
  return withAlpha(C.text, 0.22);
}

function withAlpha(hex: string, alpha: number): string {
  // #rrggbb → #rrggbbaa
  return `${hex}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0")}`;
}

export function ContributionGrid({
  totals,
  timeZone,
  weeks = 53,
}: {
  totals: DailyTotals | undefined;
  timeZone: string;
  /** Column count — scoped to the selected window by the caller. */
  weeks?: number | undefined;
}) {
  const { C } = useTheme();
  const [selected, setSelected] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const columns = useMemo(() => {
    // Day keys are generated at 12:00 UTC so Intl bucketing (D8) maps each
    // column to the reporting-timezone calendar day.
    const todayUtc = new Date();
    const today = Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth(), todayUtc.getUTCDate(), 12);
    const start = today - (weeks - 1) * 7 * DAY_MS;
    const weekday = new Date(start).getUTCDay(); // align columns to Sunday
    const aligned = start - weekday * DAY_MS;

    const out: { startMs: number; monthLabel: string | null; dayKeys: (string | null)[] }[] = [];
    let previousMonth = -1;
    for (let columnStart = aligned; columnStart <= today + 6 * DAY_MS; columnStart += 7 * DAY_MS) {
      const columnDate = new Date(columnStart);
      const monthLabel =
        columnDate.getUTCMonth() !== previousMonth
          ? columnDate.toLocaleString("en", { month: "short", timeZone: "UTC" })
          : null;
      previousMonth = columnDate.getUTCMonth();

      const dayKeys: (string | null)[] = [];
      for (let d = 0; d < 7; d++) {
        const dayMs = columnStart + d * DAY_MS;
        dayKeys.push(dayMs <= today ? bucketKey(dayMs, timeZone, "daily") : null);
      }
      out.push({ startMs: columnStart, monthLabel, dayKeys });
    }
    return out;
  }, [timeZone]);

  if (totals === undefined) return null;

  const todayKey = bucketKey(Date.now(), timeZone, "daily");
  const captionKey = selected ?? (totals.byKey[todayKey] !== undefined ? todayKey : latestKey(totals.byKey));
  const caption = captionKey === null || totals.byKey[captionKey] === undefined ? null : totals.byKey[captionKey];

  return (
    <View>
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
      >
        <View>
          <View style={styles.monthRow}>
            {columns.map((column, index) => (
              <View key={index} style={styles.monthCell}>
                {column.monthLabel !== null && (
                  <Text style={[styles.monthText, { color: C.muted }]}>{column.monthLabel}</Text>
                )}
              </View>
            ))}
          </View>
          <View style={styles.gridRow}>
            {columns.map((column, columnIndex) => (
              <View key={columnIndex} style={styles.column}>
                {column.dayKeys.map((key, dayIndex) => {
                  if (key === null) return <View key={dayIndex} style={styles.cell} />;
                  const day = totals.byKey[key];
                  return (
                    <View
                      key={key}
                      style={[
                        styles.cell,
                        {
                          backgroundColor: intensity(day === undefined ? 0 : day.tokens, totals.max, C),
                          borderColor: key === captionKey ? C.text : "transparent",
                        },
                      ]}
                      onTouchEnd={() => setSelected(key)}
                    />
                  );
                })}
              </View>
            ))}
          </View>
        </View>
      </ScrollView>

      <View style={[styles.captionRow, { marginTop: spacing.s }]}>
        <View style={styles.legend}>
          <Text style={[styles.legendText, { color: C.muted }]}>less</Text>
          {[withAlpha(C.text, 0.06), withAlpha(C.text, 0.22), withAlpha(C.text, 0.45), withAlpha(C.text, 0.7), C.text].map(
            (color, index) => (
              <View key={index} style={[styles.cell, { backgroundColor: color }]} />
            ),
          )}
          <Text style={[styles.legendText, { color: C.muted }]}>more</Text>
        </View>
        {caption !== null && captionKey !== null && (
          <Text style={[styles.caption, { color: C.muted }]} numberOfLines={1}>
            {`${captionKey}: ${formatTokens(caption.tokens)} · ${formatCost(caption.cost)}`}
          </Text>
        )}
      </View>
    </View>
  );
}

function latestKey(byKey: Record<string, { tokens: number; cost: number }>): string | null {
  let latest: string | null = null;
  for (const key of Object.keys(byKey)) {
    if (latest === null || key > latest) latest = key;
  }
  return latest;
}

const styles = StyleSheet.create({
  monthRow: { flexDirection: "row", marginBottom: 3 },
  monthCell: { width: CELL + GAP, height: 12 },
  monthText: { fontSize: 9 },
  gridRow: { flexDirection: "row" },
  column: { width: CELL + GAP, gap: GAP },
  cell: { width: CELL, height: CELL, borderRadius: 3, borderWidth: 1, borderStyle: "dotted", borderColor: "transparent" },
  captionRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 2 },
  legend: { flexDirection: "row", alignItems: "center", gap: 3 },
  legendText: { fontSize: 9.5, marginRight: 2 },
  caption: { fontSize: 11, flexShrink: 1, textAlign: "right" },
});
