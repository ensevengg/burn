import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Animated, Easing, KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, View, useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../lib/theme-context";
import { hairline, motion, radius } from "../theme";

/**
 * Bottom sheet: the backdrop fades while the sheet springs up (both on the UI
 * thread). Closing animates out before unmounting. Back button and backdrop
 * tap both dismiss.
 */
export function Sheet({ visible, onClose, children }: { visible: boolean; onClose: () => void; children: ReactNode }) {
  const { C } = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [mounted, setMounted] = useState(visible);
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.spring(progress, { toValue: 1, useNativeDriver: true, ...motion.gentle }).start();
    } else {
      Animated.timing(progress, {
        toValue: 0,
        duration: 200,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [visible, progress]);

  if (!mounted) return null;
  return (
    <Modal transparent visible animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      <KeyboardAvoidingView behavior="padding" style={styles.root}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, { opacity: progress }]}>
          <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
        </Animated.View>
        <Animated.View
          style={[
            styles.sheet,
            {
              backgroundColor: C.panel,
              borderColor: C.border,
              paddingBottom: insets.bottom + 20,
              // Tall content scrolls instead of running off the screen.
              maxHeight: height - insets.top - 24,
              transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [560, 0] }) }],
            },
          ]}
        >
          <View style={[styles.grabber, { backgroundColor: C.faint }]} />
          <ScrollView bounces={false} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            {children}
          </ScrollView>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  backdrop: { backgroundColor: "rgba(0,0,0,0.62)" },
  sheet: {
    borderTopLeftRadius: radius.l + 6,
    borderTopRightRadius: radius.l + 6,
    borderWidth: hairline,
    paddingHorizontal: 20,
    paddingTop: 10,
    // Shrinks above an open keyboard; the content scrolls inside.
    flexShrink: 1,
  },
  grabber: { alignSelf: "center", width: 38, height: 4, borderRadius: 2, marginBottom: 14, opacity: 0.6 },
});
