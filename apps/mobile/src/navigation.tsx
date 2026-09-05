import { createBottomTabNavigator, type BottomTabBarButtonProps } from "@react-navigation/bottom-tabs";
import { NavigationContainer, DarkTheme, DefaultTheme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Pressable, Text } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Path, Rect, Line } from "react-native-svg";
import { darkColors, lightColors } from "./theme";
import { useTheme } from "./lib/theme-context";
import { useApp } from "./lib/app-context";
import { DashboardScreen } from "./screens/DashboardScreen";
import { HistoryScreen } from "./screens/HistoryScreen";
import { ExploreScreen } from "./screens/ExploreScreen";
import { MachinesScreen } from "./screens/MachinesScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { SetupScreen } from "./screens/SetupScreen";

const Stack = createNativeStackNavigator<{ setup: undefined; main: undefined }>();
const Tabs = createBottomTabNavigator<{
  dashboard: undefined;
  history: undefined;
  explore: undefined;
  machines: undefined;
  settings: undefined;
}>();

/**
 * 24px stroke tab icons (user feedback: the old text glyphs were too small
 * for the space above the labels). Single-stroke geometric set, tinted by
 * the tab bar's active/inactive color.
 */
function TabIcon({ name, color, focused, bg }: { name: string; color: string; focused: boolean; bg: string }) {
  const sw = focused ? 2.4 : 2;
  const common = { stroke: color, strokeWidth: sw, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, fill: "none" };
  switch (name) {
    case "dashboard":
      return (
        <Svg width={24} height={24} viewBox="0 0 24 24">
          <Path {...common} d="M3 12h4l2.5-7 4 14 2.5-7h5" />
        </Svg>
      );
    case "history":
      return (
        <Svg width={24} height={24} viewBox="0 0 24 24">
          <Path {...common} d="M4 20V10M10 20V4M16 20v-8M22 20H2" />
        </Svg>
      );
    case "explore":
      // Compass rose (user reference): long N/S/E/W points + short diagonals,
      // no letters.
      return (
        <Svg width={24} height={24} viewBox="0 0 24 24">
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
        <Svg width={24} height={24} viewBox="0 0 24 24">
          <Rect {...common} x={3} y={4} width={18} height={7} rx={2} />
          <Rect {...common} x={3} y={13} width={18} height={7} rx={2} />
          <Line {...common} x1={7} y1={7.5} x2={7.01} y2={7.5} />
          <Line {...common} x1={7} y1={16.5} x2={7.01} y2={16.5} />
        </Svg>
      );
    default:
      return (
        <Svg width={24} height={24} viewBox="0 0 24 24">
          <Circle {...common} cx={12} cy={12} r={3.2} />
          <Path
            {...common}
            d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.08A1.7 1.7 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.03Z"
          />
        </Svg>
      );
  }
}

function MainTabs() {
  const { C } = useTheme();
  // Tab highlight must be exactly the visible box above the Android buttons
  // (user feedback): fixed item height + clipped ripple, with the system-inset
  // zone as opaque bar padding the pressables can never reach into. Some
  // OEM/3-button setups report insets.bottom = 0 — floor it.
  const insets = useSafeAreaInsets();
  const bottomInset = Math.max(insets.bottom, 44);
  const ITEM_HEIGHT = 64;
  return (
    <Tabs.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarStyle: {
          backgroundColor: C.panel,
          borderTopColor: C.border,
          height: ITEM_HEIGHT + bottomInset,
        },
        tabBarItemStyle: {
          height: ITEM_HEIGHT,
          marginHorizontal: 6,
          borderRadius: 14,
          overflow: "hidden",
        },
        tabBarButton: ({ ref: _ignoredRef, ...buttonProps }: BottomTabBarButtonProps) => (
          <Pressable {...buttonProps} android_ripple={{ color: C.border, foreground: true, borderless: false }} />
        ),
        tabBarLabel: ({ color }) => (
          <Text style={{ fontSize: 10.5, color, fontWeight: "500" }}>{route.name}</Text>
        ),
        tabBarIcon: ({ color, focused }) => (
          <TabIcon name={route.name} color={color} focused={focused} bg={C.panel} />
        ),
        tabBarActiveTintColor: C.text,
        tabBarInactiveTintColor: C.faint,
      })}
    >
      <Tabs.Screen name="dashboard" component={DashboardScreen} />
      <Tabs.Screen name="history" component={HistoryScreen} />
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
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {mode === "unconfigured" ? (
          <Stack.Screen name="setup" component={SetupScreen} />
        ) : (
          <Stack.Screen name="main" component={MainTabs} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
