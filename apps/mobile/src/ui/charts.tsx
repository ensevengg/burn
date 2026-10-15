/**
 * Chart boundary (D9: react-native-svg today, victory-native/Skia later).
 *
 * UsageChart fits the whole range to the card width — no horizontal scroll,
 * no jump-to-end on mount. Shapes morph: a refresh tweens each bucket to its
 * new value, and a range/metric change resamples the old shape onto the new
 * bucket count first, so 7d → 30d reshapes instead of blinking. Drag or tap
 * to scrub; the owner renders the readout via `onScrub`.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { PanResponder, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Defs, Line, LinearGradient, Path, Stop } from "react-native-svg";
import { useTheme } from "../lib/theme-context";
import { monotonePath, resample } from "../lib/series";
import { formatTokens } from "../lib/format";

const PAD_TOP = 14;
const PAD_BOTTOM = 22;
/** Room for the end-point halo so it never clips at the card edge. */
const PAD_X = 6;
const MORPH_MS = 460;

export interface ChartPoint {
  label: string;
  value: number;
}

function useMorph(values: number[], ceiling: number) {
  const [shown, setShown] = useState({ values, ceiling });
  const current = useRef(shown);
  useEffect(() => {
    const from = current.current;
    const start = resample(from.values, values.length);
    const fromCeiling = from.ceiling;
    if (start.every((value, i) => value === values[i]) && fromCeiling === ceiling) return;
    const began = performance.now();
    let frame = 0;
    const tick = () => {
      const t = Math.min(1, (performance.now() - began) / MORPH_MS);
      const k = 1 - Math.pow(1 - t, 3);
      const next = {
        values: values.map((value, i) => start[i]! + (value - start[i]!) * k),
        ceiling: fromCeiling + (ceiling - fromCeiling) * k,
      };
      current.current = next;
      setShown(next);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [values, ceiling]);
  return shown;
}

export function UsageChart({
  points,
  yMax,
  height = 200,
  formatY = formatTokens,
  onScrub,
}: {
  points: ChartPoint[];
  /** Fixed ceiling (historical peak for the granularity — user direction). */
  yMax?: number | undefined;
  height?: number;
  formatY?: (n: number) => string;
  onScrub?: (index: number | null) => void;
}) {
  const { C } = useTheme();
  const gradientId = useId();
  const [width, setWidth] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null);
  const values = useMemo(() => points.map((point) => point.value), [points]);
  const peak = Math.max(0, ...values);
  const ceiling = Math.max(peak, yMax ?? 0, 1e-9) * 1.08;
  const shown = useMorph(values, ceiling);

  const n = shown.values.length;
  const plotBottom = height - PAD_BOTTOM;
  const plotHeight = plotBottom - PAD_TOP;
  const plotWidth = Math.max(0, width - PAD_X * 2);
  const step = n > 1 ? plotWidth / (n - 1) : 0;
  const x = (i: number) => PAD_X + (n > 1 ? i * step : plotWidth / 2);
  const y = (v: number) => plotBottom - (Math.max(0, v) / shown.ceiling) * plotHeight;
  const coords = shown.values.map((v, i) => ({ x: x(i), y: y(v) }));
  const line = width > 0 ? monotonePath(coords) : "";
  const area =
    width > 0 && n > 0
      ? `${line}L${coords[n - 1]!.x.toFixed(1)} ${plotBottom}L${coords[0]!.x.toFixed(1)} ${plotBottom}Z`
      : "";
  const last = coords[n - 1];

  const scrubRef = useRef<{ index: number | null; timer: ReturnType<typeof setTimeout> | null }>({ index: null, timer: null });
  const geometry = useRef({ width, n });
  geometry.current = { width, n };
  const onScrubRef = useRef(onScrub);
  onScrubRef.current = onScrub;
  const responder = useMemo(() => {
    const indexAt = (locationX: number) => {
      const { width: w, n: count } = geometry.current;
      if (count <= 1 || w <= PAD_X * 2) return 0;
      return Math.max(0, Math.min(count - 1, Math.round((locationX - PAD_X) / ((w - PAD_X * 2) / (count - 1)))));
    };
    const show = (locationX: number) => {
      const index = indexAt(locationX);
      if (scrubRef.current.timer) clearTimeout(scrubRef.current.timer);
      scrubRef.current.timer = null;
      if (index === scrubRef.current.index) return;
      scrubRef.current.index = index;
      setScrub(index);
      onScrubRef.current?.(index);
    };
    const hide = (delay: number) => {
      if (scrubRef.current.timer) clearTimeout(scrubRef.current.timer);
      scrubRef.current.timer = setTimeout(() => {
        scrubRef.current.index = null;
        scrubRef.current.timer = null;
        setScrub(null);
        onScrubRef.current?.(null);
      }, delay);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderGrant: (event) => show(event.nativeEvent.locationX),
      onPanResponderMove: (event) => show(event.nativeEvent.locationX),
      // A tap leaves the readout up briefly; a drag hides it on release.
      onPanResponderRelease: (_, g) => hide(Math.abs(g.dx) < 6 ? 1400 : 220),
      // A vertical scroll that starts on the chart wins immediately.
      onPanResponderTerminate: () => hide(0),
    });
  }, []);
  useEffect(() => () => {
    if (scrubRef.current.timer) clearTimeout(scrubRef.current.timer);
  }, []);

  const scrubbed = scrub !== null && scrub < n ? coords[scrub] : undefined;
  const labelIdx = n <= 1 ? [0] : [0, Math.round((n - 1) / 2), n - 1];
  const empty = peak === 0;

  return (
    <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={{ height }}>
      {width > 0 && (
        <Svg width={width} height={height}>
          <Defs>
            <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={C.text} stopOpacity={0.22} />
              <Stop offset="0.7" stopColor={C.text} stopOpacity={0.04} />
              <Stop offset="1" stopColor={C.text} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          {[0.5, 1].map((f) => (
            <Line
              key={f}
              x1={0}
              x2={width}
              y1={plotBottom - (f / 1.08) * plotHeight}
              y2={plotBottom - (f / 1.08) * plotHeight}
              stroke={C.border}
              strokeWidth={1}
              strokeDasharray="2 5"
            />
          ))}
          <Line x1={0} x2={width} y1={plotBottom} y2={plotBottom} stroke={C.border} strokeWidth={1} />
          {!empty && <Path d={area} fill={`url(#${gradientId})`} />}
          <Path
            d={line}
            fill="none"
            stroke={empty ? C.faint : C.text}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={scrubbed ? 0.55 : 1}
          />
          {scrubbed && (
            <>
              <Line x1={scrubbed.x} x2={scrubbed.x} y1={PAD_TOP - 6} y2={plotBottom} stroke={C.muted} strokeWidth={1} />
              <Circle cx={scrubbed.x} cy={scrubbed.y} r={9} fill={C.text} opacity={0.16} />
              <Circle cx={scrubbed.x} cy={scrubbed.y} r={4.5} fill={C.text} stroke={C.bg} strokeWidth={2} />
            </>
          )}
          {!scrubbed && last && !empty && (
            <>
              <Circle cx={last.x} cy={last.y} r={8} fill={C.text} opacity={0.14} />
              <Circle cx={last.x} cy={last.y} r={3.6} fill={C.text} />
            </>
          )}
        </Svg>
      )}
      {/* Gridline values sit inside the plot so the line gets the full width. */}
      {!empty &&
        [0.5, 1].map((f) => (
          <Text
            key={f}
            style={[styles.gridLabel, { color: C.faint, top: plotBottom - (f / 1.08) * plotHeight - 15 }]}
          >
            {formatY(shown.ceiling * (f / 1.08))}
          </Text>
        ))}
      {empty && (
        <Text style={[styles.emptyLabel, { color: C.faint, top: plotBottom / 2 - 8 }]}>No usage in this range</Text>
      )}
      <View style={[styles.xLabels, { top: plotBottom + 6 }]} pointerEvents="none">
        {labelIdx.map((i, k) => (
          <Text
            key={`${i}-${k}`}
            numberOfLines={1}
            style={[
              styles.xLabel,
              { color: C.faint, textAlign: k === 0 ? "left" : k === labelIdx.length - 1 ? "right" : "center" },
            ]}
          >
            {points[i]?.label ?? ""}
          </Text>
        ))}
      </View>
      <View style={StyleSheet.absoluteFill} {...responder.panHandlers} />
    </View>
  );
}

/** Tiny trend line for tiles; no axes, ceiling 100 by default (percent vitals). */
export function Sparkline({
  values,
  ceiling = 100,
  height = 36,
  color,
}: {
  values: number[];
  ceiling?: number;
  height?: number;
  color?: string;
}) {
  const { C } = useTheme();
  const gradientId = useId();
  const [width, setWidth] = useState(0);
  const ink = color ?? C.text;
  const max = Math.max(ceiling, ...values, 1);
  const coords = values.map((value, i) => ({
    x: values.length > 1 ? (i / (values.length - 1)) * width : width,
    y: height - 2 - (value / max) * (height - 6),
  }));
  const line = width > 0 && coords.length > 1 ? monotonePath(coords) : "";
  return (
    <View style={{ height }} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      {line !== "" && (
        <Svg width={width} height={height}>
          <Defs>
            <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={ink} stopOpacity={0.2} />
              <Stop offset="1" stopColor={ink} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Path d={`${line}L${width} ${height}L0 ${height}Z`} fill={`url(#${gradientId})`} />
          <Path d={line} fill="none" stroke={ink} strokeWidth={1.6} strokeLinecap="round" />
          <Circle cx={coords.at(-1)!.x - 1.5} cy={coords.at(-1)!.y} r={2.4} fill={ink} />
        </Svg>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  gridLabel: { position: "absolute", left: PAD_X, fontSize: 10, fontVariant: ["tabular-nums"] },
  emptyLabel: { position: "absolute", left: 0, right: 0, textAlign: "center", fontSize: 12 },
  xLabels: { position: "absolute", left: PAD_X, right: PAD_X, flexDirection: "row" },
  xLabel: { flex: 1, fontSize: 10.5, fontVariant: ["tabular-nums"] },
});
