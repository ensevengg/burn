/**
 * Charts: smooth gradient area charts (the tokscale-style look), used
 * everywhere — single-series totals, stacked model/agent breakdowns, and the
 * cache-hit-rate strip. react-native-svg only; the victory-native/Skia swap
 * (D9) keeps this file's component boundary.
 */
import { useId, useEffect, useRef } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Defs, G, Line, LinearGradient, Path, Rect, Stop, Svg, Text as SvgText } from "react-native-svg";
import { useTheme } from "../lib/theme-context";
import type { SeriesBucket } from "../data/repository";
import { formatTokens } from "../lib/format";
import { spacing } from "../theme";

const FONT = 9;

export interface ChartPoint {
  label: string;
  value: number;
}

/** Catmull-Rom → cubic Bézier path through the given points. */
function smoothPath(coords: { x: number; y: number }[]): string {
  if (coords.length === 0) return "";
  if (coords.length === 1) return `M ${coords[0]!.x} ${coords[0]!.y}`;
  let d = `M ${coords[0]!.x.toFixed(2)} ${coords[0]!.y.toFixed(2)}`;
  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = coords[Math.max(0, i - 1)]!;
    const p1 = coords[i]!;
    const p2 = coords[i + 1]!;
    const p3 = coords[Math.min(coords.length - 1, i + 2)]!;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

function areaFrom(coords: { x: number; y: number }[], plotBottom: number): string {
  const line = smoothPath(coords);
  const first = coords[0]!;
  const last = coords[coords.length - 1]!;
  return `${line} L ${last.x.toFixed(2)} ${plotBottom.toFixed(2)} L ${first.x.toFixed(2)} ${plotBottom.toFixed(2)} Z`;
}

/**
 * The signature chart: smooth line + gradient area fill.
 * Pass `layers` (cumulative series per stack key, same order as `points`)
 * to render stacked areas for model/agent breakdowns.
 */
export function AreaChart({
  points,
  layers,
  height = 240,
  formatY = formatTokens,
  colorFor,
  legendKeys,
  svgWidth,
  yMax,
}: {
  points: ChartPoint[];
  layers?: { key: string; values: number[] }[] | undefined;
  height?: number | undefined;
  formatY?: ((n: number) => string) | undefined;
  colorFor?: ((key: string) => string) | undefined;
  legendKeys?: string[] | undefined;
  /** Fixed pixel width — required when rendered inside a horizontal scroller. */
  svgWidth?: number | undefined;
  /**
   * Pin the Y ceiling (user direction): the historical peak for this
   * granularity, so windows/scrolling never rescale — only X moves.
   */
  yMax?: number | undefined;
}) {
  const { C } = useTheme();
  const gradientId = useId();
  const width = svgWidth ?? Math.max(320, points.length * 34);
  const padLeft = 36;
  const plotWidth = width - padLeft - 8;
  const plotHeight = height - 24 - 8;
  const plotTop = 8;
  const plotBottom = plotTop + plotHeight;

  if (points.length === 0) return null;

  const x = (index: number) => padLeft + (index + 0.5) * (plotWidth / Math.max(1, points.length));
  const max = Math.max(
    1,
    yMax ?? 0,
    ...(layers !== undefined
      ? layers.reduce<number[]>((sums, layer) => sums.map((s, i) => s + (layer.values[i] ?? 0)), points.map(() => 0))
      : points.map((p) => p.value)),
  );
  const y = (value: number) => plotBottom - (value / max) * plotHeight;
  const gridTicks = [0, 0.5, 1];
  const labelEvery = Math.ceil(points.length / 6);

  const layerPaths = (layers ?? []).map((layer) => {
    const coords = points.map((_, i) => ({ x: x(i), y: y(layer.values[i] ?? 0) }));
    return { key: layer.key, area: areaFrom(coords, plotBottom) };
  });

  const singleCoords = points.map((p, i) => ({ x: x(i), y: y(p.value) }));

  return (
    <View>
      <Svg width={svgWidth ?? "100%"} height={height} viewBox={`0 0 ${width} ${height}`}>
        <Defs>
          <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={C.text} stopOpacity="0.28" />
            <Stop offset="1" stopColor={C.text} stopOpacity="0.02" />
          </LinearGradient>
        </Defs>
        {gridTicks.map((f) => (
          <G key={f}>
            <Line
              x1={padLeft}
              x2={width - 8}
              y1={plotBottom - f * plotHeight}
              y2={plotBottom - f * plotHeight}
              stroke={C.border}
              strokeWidth={1}
            />
            <SvgText
              x={padLeft - 5}
              y={plotBottom - f * plotHeight + 3}
              fontSize={FONT}
              fill={C.muted}
              textAnchor="end"
            >
              {formatY(max * f)}
            </SvgText>
          </G>
        ))}
        {layerPaths.length > 0 && colorFor !== undefined ? (
          layerPaths.map((layer, index) => (
            <Path
              key={layer.key}
              d={layer.area}
              fill={colorFor(layer.key)}
              fillOpacity={Math.max(0.25, 0.9 - index * 0.14)}
            />
          ))
        ) : (
          <G>
            <Path d={areaFrom(singleCoords, plotBottom)} fill={`url(#${gradientId})`} />
            <Path d={smoothPath(singleCoords)} fill="none" stroke={C.text} strokeWidth={2} strokeLinecap="round" />
            <Rect
              x={singleCoords[singleCoords.length - 1]!.x - 2.5}
              y={singleCoords[singleCoords.length - 1]!.y - 2.5}
              width={5}
              height={5}
              rx={2.5}
              fill={C.text}
            />
          </G>
        )}
        {points.map((p, index) =>
          index % labelEvery === 0 ? (
            <SvgText
              key={`${p.label}-${index}`}
              x={x(index)}
              y={height - 6}
              fontSize={FONT}
              fill={C.muted}
              textAnchor="middle"
            >
              {p.label}
            </SvgText>
          ) : null,
        )}
      </Svg>
      {legendKeys !== undefined && legendKeys.length > 1 && colorFor !== undefined && (
        <Legend stackKeys={legendKeys} colorFor={colorFor} />
      )}
    </View>
  );
}

/** Cache-hit-rate strip: same smooth area shape, fixed 0–100% domain. */
export function HitRateArea({ points }: { points: ChartPoint[] }) {
  const { C } = useTheme();
  const gradientId = useId();
  const width = Math.max(320, points.length * 34);
  const padLeft = 30;
  const plotWidth = width - padLeft - 8;
  const plotHeight = 110 - 24 - 8;
  const plotTop = 8;
  const plotBottom = plotTop + plotHeight;
  if (points.length === 0) return null;

  const coords = points.map((p, i) => ({
    x: padLeft + (i + 0.5) * (plotWidth / Math.max(1, points.length)),
    y: plotBottom - Math.min(1, Math.max(0, p.value)) * plotHeight,
  }));
  const labelEvery = Math.ceil(points.length / 6);

  return (
    <View style={{ marginHorizontal: spacing.l, marginTop: spacing.xs }}>
      <Svg width="100%" height={110} viewBox={`0 0 ${width} 110`}>
        <Defs>
          <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={C.text} stopOpacity="0.25" />
            <Stop offset="1" stopColor={C.text} stopOpacity="0.02" />
          </LinearGradient>
        </Defs>
        <Line x1={padLeft} x2={width - 8} y1={plotTop} y2={plotTop} stroke={C.border} strokeDasharray="3 4" />
        <Line x1={padLeft} x2={width - 8} y1={plotBottom} y2={plotBottom} stroke={C.border} />
        <SvgText x={padLeft - 5} y={plotTop + 3} fontSize={FONT} fill={C.muted} textAnchor="end">
          100%
        </SvgText>
        <SvgText x={padLeft - 5} y={plotBottom + 3} fontSize={FONT} fill={C.muted} textAnchor="end">
          0%
        </SvgText>
        <Path d={areaFrom(coords, plotBottom)} fill={`url(#${gradientId})`} />
        <Path d={smoothPath(coords)} fill="none" stroke={C.text} strokeWidth={2} strokeLinecap="round" />
        {points.map((p, i) =>
          i % labelEvery === 0 ? (
            <SvgText key={`${p.label}-${i}`} x={coords[i]!.x} y={110 - 6} fontSize={FONT} fill={C.muted} textAnchor="middle">
              {p.label}
            </SvgText>
          ) : null,
        )}
      </Svg>
    </View>
  );
}

function Legend({ stackKeys, colorFor }: { stackKeys: string[]; colorFor: (key: string) => string }) {
  const { C } = useTheme();
  return (
    <View style={styles.legendRow}>
      {stackKeys.slice(0, 6).map((key) => (
        <View key={key} style={styles.legendItem}>
          <View style={[styles.legendSwatch, { backgroundColor: colorFor(key), opacity: 0.85 }]} />
          <Text style={[styles.legendText, { color: C.muted }]} numberOfLines={1}>
            {key}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * Horizontally scrollable area chart (user direction: bigger, zoomed-in,
 * swipe through history). Renders at a fixed px-per-bucket scale — always
 * wider than its container for real histories — and pins the newest bucket
 * (right edge) to the viewport on mount and whenever data changes.
 */
export function ScrollableAreaChart({
  points,
  pxPerPoint = 44,
  formatY,
  ...rest
}: {
  points: ChartPoint[];
  pxPerPoint?: number;
  layers?: { key: string; values: number[] }[] | undefined;
  height?: number | undefined;
  formatY?: ((n: number) => string) | undefined;
  colorFor?: ((key: string) => string) | undefined;
  legendKeys?: string[] | undefined;
  yMax?: number | undefined;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const svgWidth = Math.max(320, points.length * pxPerPoint);

  useEffect(() => {
    // Newest on screen when the chart opens or the data changes.
    scrollRef.current?.scrollToEnd({ animated: false });
  }, [points.length]);

  return (
    <ScrollView
      ref={scrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      scrollsToTop={false}
      contentContainerStyle={{ paddingRight: spacing.s }}
    >
      <AreaChart {...rest} points={points} formatY={formatY} svgWidth={svgWidth} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  legendRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.m, marginTop: spacing.s },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 5, flexShrink: 1 },
  legendSwatch: { width: 9, height: 9, borderRadius: 2 },
  legendText: { fontSize: 11, maxWidth: 110 },
});
