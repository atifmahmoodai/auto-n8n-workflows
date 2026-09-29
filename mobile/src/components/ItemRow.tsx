import { Pressable, StyleSheet, View } from "react-native";
import { categoryLabel, formatMoney, formatQuantity } from "../lib/format";
import type { ReceiptItem } from "../lib/types";
import { space, useTheme } from "../theme";
import { Text } from "./ui";

export function ItemRow({ item, currency, onPress }: { item: ReceiptItem; currency: string; onPress?: () => void }) {
  const { colors } = useTheme();
  const detail =
    item.quantity !== 1 && item.unitPrice !== null
      ? `${formatQuantity(item.quantity)} × ${formatMoney(item.unitPrice, currency)}`
      : item.quantity !== 1
        ? `Qty ${formatQuantity(item.quantity)}`
        : null;
  return (
    <Pressable
      disabled={!onPress}
      onPress={onPress}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityHint={onPress ? "Edit item" : undefined}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surfaceMuted }]}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="bodyStrong" numberOfLines={2}>
          {item.name}
        </Text>
        <Text variant="caption" tone="faint">
          {[categoryLabel(item.category), detail].filter(Boolean).join(" · ")}
        </Text>
      </View>
      <Text variant="bodyStrong" tone={item.totalPrice < 0 ? "accent" : "default"}>
        {formatMoney(item.totalPrice, currency)}
      </Text>
    </Pressable>
  );
}

export function TotalLine({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.total}>
      <Text variant={strong ? "headline" : "body"} tone={strong ? "default" : "muted"}>
        {label}
      </Text>
      <Text variant={strong ? "title" : "bodyStrong"}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.md, paddingHorizontal: space.xs, borderRadius: 10 },
  total: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 4 },
});
