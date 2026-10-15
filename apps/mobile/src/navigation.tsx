import { useEffect, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { createBottomTabNavigator, type BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { NavigationContainer, DarkTheme, DefaultTheme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import Svg, { Circle, Defs, LinearGradient, Path, Rect, Line, Stop } from "react-native-svg";
import { darkColors, hairline, lightColors, motion } from "./theme";
import { useTheme } from "./lib/theme-context";
import { useApp } from "./lib/app-context";
import { PressableScale } from "./ui/motion";
import { TAB_BAR_HEIGHT, tabBarGap } from "./ui/screen";
import { DashboardScreen } from "./screens/DashboardScreen";
import { SystemsScreen } from "./screens/SystemsScreen";
import { ExploreScreen } from "./screens/ExploreScreen";
import { MachinesScreen } from "./screens/MachinesScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { SetupScreen } from "./screens/SetupScreen";

const Stack = createNativeStackNavigator<{ setup: undefined; main: undefined }>();
const Tabs = createBottomTabNavigator<{
  dashboard: undefined;
  systems: undefined;
  explore: undefined;
  machines: undefined;
  settings: undefined;
}>();

const TAB_LABELS: Record<string, string> = {
  dashboard: "Overview",
  systems: "Systems",
  explore: "Explore",
  machines: "Machines",
  settings: "Settings",
};

/**
 * 22px stroke tab icons (user feedback: the old text glyphs were too small).
 * Single-stroke geometric set, tinted by active/inactive color. `bg` is the
 * surface behind the icon, used for the compass rose's inner cut-out.
 */
function TabIcon({ name, color, focused, bg }: { name: string; color: string; focused: boolean; bg: string }) {
  const sw = focused ? 2.3 : 1.9;
  const common = { stroke: color, strokeWidth: sw, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, fill: "none" };
  switch (name) {
    case "dashboard":
      return (
        <Svg width={22} height={22} viewBox="0 0 24 24">
          <Path {...common} d="M3 12h4l2.5-7 4 14 2.5-7h5" />
        </Svg>
      );
    case "systems":
      return (
        <Svg width={22} height={22} viewBox="0 0 24 24">
          <Rect {...common} x={2.5} y={4} width={19} height={14} rx={2} />
          <Path {...common} d="M5.5 11h3l1.5-3 3 6 1.5-3h4" />
          <Path {...common} d="M9 21h6M12 18v3" />
        </Svg>
      );
    case "explore":
      // Compass rose (user reference): long N/S/E/W points, no letters.
      return (
        <Svg width={22} height={22} viewBox="0 0 24 24">
          <Path
            d="M12 1.5 C12.9 8.2 15.8 11.1 22.5 12 C15.8 12.9 12.9 15.8 12 22.5 C11.1 15.8 8.2 12.9 1.5 12 C8.2 11.1 11.1 8.2 12 1.5 Z"
            fill={color}
          />
          <Path
            d="M12 5.5 C12.5 9.4 14.6 11.5 18.5 12 C14.6 12.5 12.5 14.6 12 18.5 C11.5 14.6 9.4 12.5 5.5 12 C9.4 11.5 11.5 9.4 12 5.5 Z"
            fill={bg}
          />
        </Svg>
      );
    case "machines":
      return (
        <Svg width={22} height={22} viewBox="0 0 24 24">
          <Rect {...common} x={3} y={4} width={18} height={7} rx={2} />
          <Rect {...common} x={3} y={13} width={18} height={7} rx={2} />
          <Line {...common} x1={7} y1={7.5} x2={7.01} y2={7.5} />
          <Line {...common} x1={7} y1={16.5} x2={7.01} y2={16.5} />
        </Svg>
      );
    default:
      return (
        <Svg width={22} height={22} viewBox="0 0 24 24">
          <Circle {...common} cx={12} cy={12} r={3.2} />
          <Path
            {...common}
            d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.08A1.7 1.7 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.03Z"
          />
        </Svg>
      );
  }
}

/**
 * Floating pill tab bar. The selection highlight springs between tabs on the
 * UI thread; a gradient scrim fades content out beneath the bar and the
 * system navigation buttons. Each tab's touch target is exactly its slot
 * inside the pill (user feedback: highlights must stay inside the visible box).
 */
function FloatingTabBar({ state, navigation, insets }: BottomTabBarProps) {
  const { C, resolved } = useTheme();
  const window = useWindowDimensions();
  const [width, setWidth] = useState(0);
  const position = useRef(new Animated.Value(state.index)).current;
  useEffect(() => {
    Animated.spring(position, { toValue: state.index, useNativeDriver: true, ...motion.snappy }).start();
  }, [state.index, position]);
  const count = state.routes.length;
  const slot = width / count;
  const gap = tabBarGap(insets.bottom);
  const highlight = resolved === "light" ? C.panelAlt : C.selection;
  return (
    <View pointerEvents="box-none" style={styles.tabRoot}>
      <Svg pointerEvents="none" width={window.width} height={gap + TAB_BAR_HEIGHT + 40} style={styles.scrim}>
        <Defs>
          <LinearGradient id="tabScrim" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={C.bg} stopOpacity={0} />
            <Stop offset="0.35" stopColor={C.bg} stopOpacity={0.9} />
            <Stop offset="0.6" stopColor={C.bg} stopOpacity={1} />
          </LinearGradient>
        </Defs>
        <Rect x={0} y={0} width={window.width} height={gap + TAB_BAR_HEIGHT + 40} fill="url(#tabScrim)" />
      </Svg>
      <View
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        style={[styles.tabBar, { marginBottom: gap, backgroundColor: C.chrome, borderColor: C.border }]}
      >
        {slot > 0 && (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.tabHighlight,
              {
                width: slot - 8,
                backgroundColor: highlight,
                transform: [
                  {
                    translateX: position.interpolate({
                      inputRange: [0, count - 1],
                      outputRange: [4, 4 + slot * (count - 1)],
                    }),
                  },
                ],
              },
            ]}
          />
        )}
        {state.routes.map((route, index) => {
          const focused = state.index === index;
          const color = focused ? C.text : C.faint;
          const label = TAB_LABELS[route.name] ?? route.name;
          return (
            <PressableScale
              key={route.key}
              scaleTo={0.9}
              unstable_pressDelay={0}
              accessibilityRole="tab"
              accessibilityLabel={label}
              accessibilityState={{ selected: focused }}
              onPress={() => {
                const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
                if (!focused && !event.defaultPrevented) navigation.navigate(route.name, route.params);
              }}
              onLongPress={() => navigation.emit({ type: "tabLongPress", target: route.key })}
              containerStyle={styles.tabSlot}
              style={styles.tabItem}
            >
              <TabIcon name={route.name} color={color} focused={focused} bg={focused ? highlight : C.chrome} />
              <Text style={[styles.tabLabel, { color }]} numberOfLines={1}>
                {label}
              </Text>
            </PressableScale>
          );
        })}
      </View>
    </View>
  );
}

function MainTabs() {
  return (
    <Tabs.Navigator
      tabBar={(props) => <FloatingTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        // Fade-through: the outgoing screen is gone by the midpoint, so two
        // dense screens never cross-dissolve into mush.
        sceneStyleInterpolator: ({ current }) => ({
          sceneStyle: {
            opacity: current.progress.interpolate({
              inputRange: [-1, -0.5, 0, 0.5, 1],
              outputRange: [0, 0, 1, 0, 0],
            }),
            transform: [
              {
                translateX: current.progress.interpolate({
                  inputRange: [-1, 0, 1],
                  outputRange: [-18, 0, 18],
                }),
              },
            ],
          },
        }),
        transitionSpec: {
          animation: "timing",
          config: { duration: 240, easing: Easing.bezier(0.2, 0.8, 0.2, 1) },
        },
      }}
    >
      <Tabs.Screen name="dashboard" component={DashboardScreen} />
      <Tabs.Screen name="systems" component={SystemsScreen} />
      <Tabs.Screen name="explore" component={ExploreScreen} />
      <Tabs.Screen name="machines" component={MachinesScreen} />
      <Tabs.Screen name="settings" component={SettingsScreen} />
    </Tabs.Navigator>
  );
}

export default function Navigation() {
  const { resolved } = useTheme();
  const { mode } = useApp();
  const base = resolved === "light" ? DefaultTheme : DarkTheme;
  const C = resolved === "light" ? lightColors : darkColors;
  return (
    <NavigationContainer
      theme={{
        ...base,
        colors: {
          ...base.colors,
          background: C.bg,
          card: C.panel,
          border: C.border,
          text: C.text,
          primary: C.text,
        },
      }}
    >
      <Stack.Navigator screenOptions={{ headerShown: false, animation: "fade" }}>
        {mode === "unconfigured" ? (
          <Stack.Screen name="setup" component={SetupScreen} />
        ) : (
          <Stack.Screen name="main" component={MainTabs} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  // Elevation lifts the scrim with the bar above the native screen container.
  tabRoot: { position: "absolute", left: 0, right: 0, bottom: 0, elevation: 12 },
  scrim: { position: "absolute", left: 0, right: 0, bottom: 0 },
  tabBar: {
    flexDirection: "row",
    height: TAB_BAR_HEIGHT,
    marginHorizontal: 16,
    borderRadius: TAB_BAR_HEIGHT / 2,
    borderWidth: hairline,
    elevation: 10,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
  },
  tabHighlight: {
    position: "absolute",
    top: 5,
    bottom: 5,
    borderRadius: (TAB_BAR_HEIGHT - 10) / 2,
  },
  tabSlot: { flex: 1 },
  tabItem: { height: TAB_BAR_HEIGHT, alignItems: "center", justifyContent: "center", gap: 3 },
  tabLabel: { fontSize: 10.5, fontWeight: "600", letterSpacing: 0.1 },
});
