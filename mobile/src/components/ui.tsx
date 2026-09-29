import Ionicons from "@expo/vector-icons/Ionicons";
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import type { ComponentProps, ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text as RNText,
  View,
  type StyleProp,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { radius, space, type, useTheme } from "../theme";
import type { SyncStatus } from "../lib/types";

export type IconName = ComponentProps<typeof Ionicons>["name"];

type Variant = keyof typeof type;

export function Text({
  variant = "body",
  tone = "default",
  style,
  ...props
}: TextProps & { variant?: Variant; tone?: "default" | "muted" | "faint" | "accent" | "danger" | "onAccent" }) {
  const { colors } = useTheme();
  const color = {
    default: colors.text,
    muted: colors.textMuted,
    faint: colors.textFaint,
    accent: colors.accent,
    danger: colors.danger,
    onAccent: colors.onAccent,
  }[tone];
  return <RNText {...props} style={[type[variant] as TextStyle, { color }, style]} />;
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }, style]}>{children}</View>
  );
}

type ButtonProps = {
  title: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function Button({ title, onPress, variant = "primary", icon, loading, disabled, style }: ButtonProps) {
  const { colors } = useTheme();
  const inactive = disabled || loading;
  const fg = {
    primary: colors.onAccent,
    secondary: colors.text,
    ghost: colors.accent,
    danger: colors.danger,
  }[variant];
  const bg = {
    primary: colors.accent,
    secondary: colors.surfaceMuted,
    ghost: "transparent",
    danger: colors.dangerSoft,
  }[variant];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      disabled={inactive}
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, opacity: inactive ? 0.55 : pressed ? 0.85 : 1, transform: [{ scale: pressed ? 0.985 : 1 }] },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={19} color={fg} /> : null}
          <RNText style={[type.headline as TextStyle, { color: fg }]}>{title}</RNText>
        </>
      )}
    </Pressable>
  );
}

export function IconButton({
  icon,
  onPress,
  label,
  color,
  background,
  size = 22,
}: {
  icon: IconName;
  onPress: () => void;
  label: string;
  color?: string;
  background?: string;
  size?: number;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        { backgroundColor: background ?? colors.surfaceMuted, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <Ionicons name={icon} size={size} color={color ?? colors.text} />
    </Pressable>
  );
}

export function GradientHero({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { colors } = useTheme();
  return (
    <LinearGradient
      colors={[colors.heroFrom, colors.heroTo]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.hero, style]}
    >
      {children}
    </LinearGradient>
  );
}

const AVATAR_TINTS = ["#0F9D74", "#3B82F6", "#8B5CF6", "#E0664F", "#D69E2E", "#0EA5B7", "#DB2777"];

export function MerchantAvatar({ name, size = 44 }: { name: string; size?: number }) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const tint = AVATAR_TINTS[Math.abs(hash) % AVATAR_TINTS.length]!;
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 3, backgroundColor: tint + "22" }]}>
      <RNText style={{ color: tint, fontSize: size * 0.42, fontWeight: "700" }}>{initial}</RNText>
    </View>
  );
}

export function SyncBadge({ status, compact }: { status: SyncStatus; compact?: boolean }) {
  const { colors } = useTheme();
  const map = {
    synced: { icon: "cloud-done" as const, label: "Synced", fg: colors.accent, bg: colors.accentSoft },
    pending: { icon: "cloud-upload-outline" as const, label: "Syncing", fg: colors.textMuted, bg: colors.surfaceMuted },
    failed: { icon: "cloud-offline-outline" as const, label: "Not synced", fg: colors.danger, bg: colors.dangerSoft },
  }[status];
  if (compact) return <Ionicons name={map.icon} size={16} color={map.fg} accessibilityLabel={map.label} />;
  return (
    <View style={[styles.badge, { backgroundColor: map.bg }]}>
      <Ionicons name={map.icon} size={14} color={map.fg} />
      <RNText style={[type.caption as TextStyle, { color: map.fg }]}>{map.label}</RNText>
    </View>
  );
}

export function Divider() {
  const { colors } = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border }} />;
}

export function EmptyState({ icon, title, body, action }: { icon: IconName; title: string; body: string; action?: ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={styles.empty}>
      <View style={[styles.emptyIcon, { backgroundColor: colors.accentSoft }]}>
        <Ionicons name={icon} size={30} color={colors.accent} />
      </View>
      <Text variant="headline" style={{ textAlign: "center" }}>
        {title}
      </Text>
      <Text tone="muted" style={{ textAlign: "center", maxWidth: 280 }}>
        {body}
      </Text>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.lg,
  },
  button: {
    minHeight: 54,
    borderRadius: radius.md,
    paddingHorizontal: space.xl,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  hero: {
    borderRadius: radius.xl,
    padding: space.xl,
    overflow: "hidden",
  },
  avatar: {
    alignItems: "center",
    justifyContent: "center",
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    alignSelf: "flex-start",
  },
  empty: {
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.xxl,
    paddingHorizontal: space.xl,
  },
  emptyIcon: {
    width: 68,
    height: 68,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space.xs,
  },
});
