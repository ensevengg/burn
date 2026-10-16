/**
 * Motion primitives. Everything that can run on the UI thread does
 * (useNativeDriver: opacity/transform only); the JS-driven piece is number
 * tweening, where each tween re-renders only its own Text.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Animated,
  Easing,
  Pressable,
  Text,
  type GestureResponderEvent,
  type PressableProps,
  type StyleProp,
  type TextProps,
  type ViewStyle,
} from "react-native";
import { motion } from "../theme";

/** Expo-out: fast start, long soft landing. */
export const easeOut = Easing.bezier(0.16, 1, 0.3, 1);

/**
 * Tween toward `target` on the JS thread (rAF). Retargeting mid-flight starts
 * from the currently displayed value, so rapid refreshes never jump. A
 * duration of 0 follows the target exactly (e.g. under a finger); the next
 * timed target then glides from wherever that left off.
 */
export function useTweenedNumber(target: number, duration = 520, from?: number): number {
  const [value, setValue] = useState(from ?? target);
  const shown = useRef(from ?? target);
  const instant = duration <= 0;
  useEffect(() => {
    if (instant) {
      shown.current = target;
      setValue(target);
      return;
    }
    const start = shown.current;
    if (start === target) return;
    const began = performance.now();
    let frame = 0;
    const tick = () => {
      const t = Math.min(1, (performance.now() - began) / duration);
      const k = 1 - Math.pow(1 - t, 3);
      shown.current = start + (target - start) * k;
      setValue(shown.current);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, duration, instant]);
  return instant ? target : value;
}

/**
 * Text for a number that glides to new values (refreshes, range switches)
 * instead of snapping. Key it by unit when the format changes meaning.
 */
export function TweenText({
  value,
  format,
  duration = 650,
  ...props
}: Omit<TextProps, "children"> & { value: number; format: (n: number) => string; duration?: number }) {
  const shown = useTweenedNumber(value, duration);
  return <Text {...props}>{format(shown)}</Text>;
}

/** Mount-in: fade + 10dp rise. `delay` staggers sections. Runs once per mount. */
export function FadeIn({
  children,
  delay = 0,
  style,
}: {
  children: ReactNode;
  delay?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(progress, {
      toValue: 1,
      duration: motion.slow,
      delay,
      easing: easeOut,
      useNativeDriver: true,
    }).start();
  }, [progress, delay]);
  return (
    <Animated.View
      style={[
        style,
        {
          opacity: progress,
          transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

/**
 * Pressable that sinks slightly under the finger. Press-in is delayed like a
 * native list item inside a scroll container, so a pull or scroll that starts
 * on a control never flashes its pressed state.
 */
export function PressableScale({
  children,
  style,
  containerStyle,
  scaleTo = 0.97,
  onPressIn,
  onPressOut,
  ...rest
}: Omit<PressableProps, "style" | "children"> & {
  children: ReactNode;
  /** Applied to the scaling inner view (visual box). */
  style?: StyleProp<ViewStyle>;
  /** Applied to the touch target (layout: flex, width). */
  containerStyle?: StyleProp<ViewStyle>;
  scaleTo?: number;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const to = (value: number) =>
    Animated.spring(scale, { toValue: value, useNativeDriver: true, ...motion.snappy }).start();
  return (
    <Pressable
      style={containerStyle}
      unstable_pressDelay={70}
      onPressIn={(event: GestureResponderEvent) => {
        to(scaleTo);
        onPressIn?.(event);
      }}
      onPressOut={(event: GestureResponderEvent) => {
        to(1);
        onPressOut?.(event);
      }}
      {...rest}
    >
      <Animated.View style={[style, { transform: [{ scale }] }]}>{children}</Animated.View>
    </Pressable>
  );
}

/** Breathing opacity loop for "in progress" dots. */
export function Pulse({ active, children }: { active: boolean; children: ReactNode }) {
  const value = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!active) {
      value.stopAnimation();
      Animated.timing(value, { toValue: 1, duration: motion.fast, useNativeDriver: true }).start();
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, { toValue: 0.25, duration: 520, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(value, { toValue: 1, duration: 520, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, value]);
  return <Animated.View style={{ opacity: value }}>{children}</Animated.View>;
}

/** Shimmer-free skeleton block: a slow opacity breath reads as "loading" without strobing. */
export function Skeleton({ style }: { style?: StyleProp<ViewStyle> }) {
  const value = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, { toValue: 0.9, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(value, { toValue: 0.45, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [value]);
  return <Animated.View style={[style, { opacity: value }]} />;
}

/**
 * Bar that grows from the left to `fraction` on the UI thread (scaleX with a
 * left transform origin), re-animating whenever the fraction changes.
 */
export function GrowBar({
  fraction,
  color,
  track,
  height = 4,
  delay = 0,
}: {
  fraction: number;
  color: string;
  track: string;
  height?: number;
  delay?: number;
}) {
  const scale = useRef(new Animated.Value(0)).current;
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  useEffect(() => {
    Animated.timing(scale, {
      toValue: clamped,
      duration: motion.slow + 80,
      delay,
      easing: easeOut,
      useNativeDriver: true,
    }).start();
  }, [clamped, delay, scale]);
  return (
    <Animated.View style={{ height, borderRadius: height, backgroundColor: track, overflow: "hidden" }}>
      <Animated.View
        style={{
          height,
          borderRadius: height,
          backgroundColor: color,
          transformOrigin: "left",
          transform: [{ scaleX: scale }],
        }}
      />
    </Animated.View>
  );
}
