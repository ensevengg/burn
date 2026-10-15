/**
 * Screen chrome: a fixed top bar (compact title + sync pill) over a scrolling
 * large title, a pull gesture that acknowledges fast and hands progress to
 * the pill, and bottom space for the floating tab bar. Scroll-linked motion
 * runs on the UI thread (native-driven Animated.event).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, RefreshControl, StyleSheet, Text, View, type ScrollViewProps } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import { useApp, useSyncStatus } from "../lib/app-context";
import { formatRelative } from "../lib/format";
import { useTheme } from "../lib/theme-context";
import { useMachinesQuery } from "../data/queries";
import { gutter, hairline, radius, type } from "../theme";
import { PressableScale, Pulse } from "./motion";

export const TAB_BAR_HEIGHT = 62;
const TOP_BAR = 58;

/** Distance from the screen bottom to the floating tab bar's bottom edge. */
export function tabBarGap(insetBottom: number): number {
  return Math.max(insetBottom, 12) + 8;
}

/**
 * Pull gesture: the spinner acknowledges for at least 450ms and at most
 * 1.1s, then the sync pill carries progress. It never waits on the slowest
 * (usually offline) machine's timeout.
 */
export function usePullRefresh() {
  const { mode, requestSync } = useApp();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    const began = Date.now();
    const release = () => setRefreshing(false);
    timers.current.push(setTimeout(release, 1100));
    const work = mode === "direct" ? requestSync(null) : queryClient.refetchQueries({ type: "active" });
    void Promise.resolve(work)
      .catch(() => {})
      .finally(() => {
        timers.current.push(setTimeout(release, Math.max(0, 450 - (Date.now() - began))));
      });
  }, [mode, requestSync, queryClient]);
  return { refreshing, onRefresh };
}

/**
 * Ambient sync status. Idle: how many machines answered and when. Syncing:
 * a breathing dot and per-machine progress as each one settles. Tapping
 * starts a refresh from any screen.
 */
export function SyncPill() {
  const { C } = useTheme();
  const { mode, requestSync } = useApp();
  const { pass, machineStates, syncNotice, lastSync } = useSyncStatus();
  const machines = useMachinesQuery();
  const [, tick] = useState(0);
  const [flash, setFlash] = useState(false);
  const total = machines.data?.length ?? 0;
  const settled = pass === null ? 0 : pass.ids.filter((id) => pass.settled[id] !== undefined).length;
  const syncing = pass !== null && settled < pass.ids.length;
  const wasSyncing = useRef(false);

  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (wasSyncing.current && !syncing) {
      setFlash(true);
      const timer = setTimeout(() => setFlash(false), 1600);
      wasSyncing.current = false;
      return () => clearTimeout(timer);
    }
    wasSyncing.current = syncing;
    return undefined;
  }, [syncing]);

  let dot = C.faint;
  let label: string;
  let busy = false;
  if (mode === "demo") {
    label = "Demo data";
  } else if (syncing) {
    busy = true;
    dot = C.text;
    label = pass!.ids.length > 1 ? `Syncing ${settled}/${pass!.ids.length}` : "Syncing";
  } else if (syncNotice !== null) {
    busy = true;
    dot = C.text;
    label = "Backfilling";
  } else if (flash) {
    dot = C.ok;
    label = "Up to date";
  } else if (total === 0) {
    label = "No machines";
  } else {
    const ids = machines.data!.map((machine) => machine.id);
    const live = ids.filter((id) => machineStates[id] === "live").length;
    const broken = ids.some((id) => machineStates[id] === "error" || machineStates[id] === "skipped");
    const known = ids.some((id) => machineStates[id] !== undefined);
    dot = broken ? C.warn : live > 0 ? C.ok : C.faint;
    const when = lastSync === null ? "" : ` · ${formatRelative(lastSync.toISOString()).replace(" ago", "")}`;
    label = !known ? "Cached" : live === 0 ? "Offline · cached" : `${live === total ? live : `${live}/${total}`} live${when}`;
  }

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${label}. Sync machines now`}
      hitSlop={8}
      onPress={() => {
        if (mode === "direct") void requestSync(null);
      }}
      style={[styles.pill, { backgroundColor: C.panel, borderColor: C.border }]}
    >
      <Pulse active={busy}>
        <View style={[styles.pillDot, { backgroundColor: dot }]} />
      </Pulse>
      <Text style={[styles.pillText, { color: busy ? C.text : C.muted }]} numberOfLines={1}>
        {label}
      </Text>
    </PressableScale>
  );
}

function useHeader(title: string, trailing: ReactNode) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const scrollY = useRef(new Animated.Value(0)).current;
  const onScroll = Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: true });
  // The large title shares the bar's row at rest; the bar only gains a
  // background (and a compact title) once content slides beneath it.
  const backdrop = scrollY.interpolate({ inputRange: [4, 36], outputRange: [0, 1], extrapolate: "clamp" });
  const compact = scrollY.interpolate({ inputRange: [30, 56], outputRange: [0, 1], extrapolate: "clamp" });
  const large = scrollY.interpolate({ inputRange: [0, 36], outputRange: [1, 0], extrapolate: "clamp" });
  const bar = (
    <View pointerEvents="box-none" style={[styles.bar, { height: insets.top + TOP_BAR }]}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: C.bg, opacity: backdrop }]} />
      <Animated.View pointerEvents="none" style={[styles.barEdge, { backgroundColor: C.border, opacity: compact }]} />
      <View pointerEvents="box-none" style={[styles.barRow, { marginTop: insets.top }]}>
        <Animated.Text
          numberOfLines={1}
          style={[
            styles.compactTitle,
            {
              color: C.text,
              opacity: compact,
              transform: [{ translateY: compact.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
            },
          ]}
        >
          {title}
        </Animated.Text>
        {trailing}
      </View>
    </View>
  );
  const largeTitle = (
    <Animated.View
      style={[
        styles.largeRow,
        {
          opacity: large,
          transform: [{ translateY: scrollY.interpolate({ inputRange: [-80, 0, 60], outputRange: [10, 0, -10], extrapolate: "clamp" }) }],
        },
      ]}
    >
      <Text style={[type.title, { color: C.text }]} numberOfLines={1}>
        {title}
      </Text>
    </Animated.View>
  );
  return {
    bar,
    largeTitle,
    onScroll,
    top: insets.top,
    refreshOffset: insets.top + TOP_BAR - 6,
    bottom: tabBarGap(insets.bottom) + TAB_BAR_HEIGHT + 28,
  };
}

/** Props every scroll container on a tab screen shares. */
export interface ScreenScroll {
  onScroll: ScrollViewProps["onScroll"];
  scrollEventThrottle: number;
  contentContainerStyle: { paddingTop: number; paddingBottom: number };
  refreshControl: React.ReactElement<React.ComponentProps<typeof RefreshControl>> | undefined;
  /** Large title — render as the first element of the scroll content. */
  largeTitle: ReactNode;
}

/**
 * Tab-screen scaffold. Pass `children` for a plain scroll screen, or
 * `renderList` to build a virtualized list from the shared scroll props.
 */
export function Screen({
  title,
  children,
  renderList,
  refreshable = true,
  trailing,
}: {
  title: string;
  children?: ReactNode;
  renderList?: (scroll: ScreenScroll) => ReactNode;
  refreshable?: boolean;
  trailing?: ReactNode;
}) {
  const { C } = useTheme();
  const { bar, largeTitle, onScroll, top, refreshOffset, bottom } = useHeader(title, trailing ?? <SyncPill />);
  const { refreshing, onRefresh } = usePullRefresh();
  const refreshControl = refreshable ? (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={onRefresh}
      colors={[C.text]}
      tintColor={C.text}
      progressBackgroundColor={C.panelAlt}
      progressViewOffset={refreshOffset}
    />
  ) : undefined;
  const scroll: ScreenScroll = {
    onScroll,
    scrollEventThrottle: 16,
    contentContainerStyle: { paddingTop: top, paddingBottom: bottom },
    refreshControl,
    largeTitle,
  };
  return (
    <View style={[styles.screen, { backgroundColor: C.bg }]}>
      {renderList ? (
        renderList(scroll)
      ) : (
        <Animated.ScrollView
          onScroll={scroll.onScroll}
          scrollEventThrottle={16}
          contentContainerStyle={scroll.contentContainerStyle}
          refreshControl={refreshControl}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {largeTitle}
          {children}
        </Animated.ScrollView>
      )}
      {bar}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  bar: { position: "absolute", top: 0, left: 0, right: 0 },
  barEdge: { position: "absolute", left: 0, right: 0, bottom: 0, height: hairline },
  barRow: {
    height: TOP_BAR,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: gutter,
    gap: 12,
  },
  compactTitle: { flex: 1, fontSize: 17, fontWeight: "700", letterSpacing: -0.3 },
  largeRow: { height: TOP_BAR, justifyContent: "center", paddingLeft: gutter, paddingRight: 170 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 11,
    height: 30,
    borderRadius: radius.pill,
    borderWidth: hairline,
  },
  pillDot: { width: 7, height: 7, borderRadius: 4 },
  pillText: { fontSize: 12, fontWeight: "600", fontVariant: ["tabular-nums"] },
});
