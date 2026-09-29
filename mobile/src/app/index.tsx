import Ionicons from "@expo/vector-icons/Ionicons";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { FlatList, Image, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EmptyState, GradientHero, IconButton, MerchantAvatar, SyncBadge, Text } from "../components/ui";
import { useAuth } from "../lib/auth";
import { formatDate, formatMoney, greeting } from "../lib/format";
import { monthStats } from "../lib/stats";
import { syncAllPending } from "../lib/sync";
import type { ReceiptSummary } from "../lib/types";
import { useReceiptList } from "../lib/useReceipts";
import { radius, space, useTheme } from "../theme";

function SummaryCard({ receipts }: { receipts: ReceiptSummary[] }) {
  const stats = useMemo(() => monthStats(receipts), [receipts]);
  const monthName = new Date().toLocaleDateString(undefined, { month: "long" });
  if (!stats) return null;
  const change = stats.lastMonth > 0 ? ((stats.thisMonth - stats.lastMonth) / stats.lastMonth) * 100 : null;
  return (
    <GradientHero style={{ gap: space.lg }}>
      <Text variant="overline" style={{ color: "rgba(255,255,255,0.7)" }}>
        Spent in {monthName}
      </Text>
      <Text variant="display" style={{ color: "#FFFFFF", fontSize: 40 }} adjustsFontSizeToFit numberOfLines={1}>
        {formatMoney(stats.thisMonth, stats.currency)}
      </Text>
      <View style={styles.heroRow}>
        <HeroStat label="Receipts" value={String(stats.receiptCount)} />
        <HeroStat label="Last month" value={formatMoney(stats.lastMonth, stats.currency)} />
        {change !== null ? (
          <HeroStat label="Change" value={`${change > 0 ? "+" : ""}${change.toFixed(0)}%`} />
        ) : null}
      </View>
      {stats.otherCurrencies > 0 ? (
        <Text variant="caption" style={{ color: "rgba(255,255,255,0.6)" }}>
          +{stats.otherCurrencies} receipt{stats.otherCurrencies > 1 ? "s" : ""} in other currencies
        </Text>
      ) : null}
    </GradientHero>
  );
}

function HeroStat({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ gap: 2, flexShrink: 1 }}>
      <Text variant="caption" style={{ color: "rgba(255,255,255,0.6)" }}>
        {label}
      </Text>
      <Text variant="bodyStrong" style={{ color: "#FFFFFF" }} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function ReceiptRow({ receipt }: { receipt: ReceiptSummary }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push({ pathname: "/receipt/[id]", params: { id: receipt.id } })}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? colors.surfaceMuted : colors.surface, borderColor: colors.border },
      ]}
    >
      <MerchantAvatar name={receipt.merchant} />
      <View style={{ flex: 1, gap: 3 }}>
        <Text variant="bodyStrong" numberOfLines={1}>
          {receipt.merchant}
        </Text>
        <Text variant="caption" tone="muted">
          {formatDate(receipt.purchaseDate)} · {receipt.itemCount} item{receipt.itemCount === 1 ? "" : "s"}
        </Text>
      </View>
      <View style={{ alignItems: "flex-end", gap: 4 }}>
        <Text variant="bodyStrong">{formatMoney(receipt.total, receipt.currency)}</Text>
        <SyncBadge status={receipt.syncStatus} compact />
      </View>
    </Pressable>
  );
}

export default function HomeScreen() {
  const { user } = useAuth();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { receipts, error, reload } = useReceiptList();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = async () => {
    setRefreshing(true);
    await syncAllPending();
    await reload();
    setRefreshing(false);
  };

  const firstName = user?.givenName ?? user?.name?.split(" ")[0] ?? "";

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <FlatList
        data={receipts ?? []}
        keyExtractor={(r) => r.id}
        renderItem={({ item }) => <ReceiptRow receipt={item} />}
        ItemSeparatorComponent={() => <View style={{ height: space.sm }} />}
        contentContainerStyle={{
          paddingTop: insets.top + space.md,
          paddingBottom: insets.bottom + 120,
          paddingHorizontal: space.lg,
        }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
        ListHeaderComponent={
          <View style={{ gap: space.xl, marginBottom: space.lg }}>
            <View style={styles.header}>
              <View style={{ flex: 1 }}>
                <Text tone="muted">{greeting()}{firstName ? "," : ""}</Text>
                <Text variant="title">{firstName || "Welcome"}</Text>
              </View>
              {user?.photo ? (
                <Pressable accessibilityRole="button" accessibilityLabel="Settings" onPress={() => router.push("/settings")}>
                  <Image source={{ uri: user.photo }} style={styles.profile} />
                </Pressable>
              ) : (
                <IconButton icon="person-outline" label="Settings" onPress={() => router.push("/settings")} />
              )}
            </View>
            {receipts && receipts.length > 0 ? <SummaryCard receipts={receipts} /> : null}
            {receipts && receipts.length > 0 ? <Text variant="headline">Recent receipts</Text> : null}
          </View>
        }
        ListEmptyComponent={
          receipts === null ? null : error ? (
            <EmptyState icon="alert-circle-outline" title="Something went wrong" body={error} />
          ) : (
            <EmptyState
              icon="receipt-outline"
              title="No receipts yet"
              body="Scan your first receipt and every item and price will show up here and in your Google Sheet."
            />
          )
        }
      />

      <View pointerEvents="box-none" style={[styles.fabWrap, { bottom: insets.bottom + space.lg }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Scan a receipt"
          onPress={() => router.push("/scan")}
          style={({ pressed }) => [
            styles.fab,
            { backgroundColor: colors.accent, transform: [{ scale: pressed ? 0.97 : 1 }], shadowColor: colors.accent },
          ]}
        >
          <Ionicons name="scan" size={22} color={colors.onAccent} />
          <Text variant="headline" tone="onAccent">
            Scan receipt
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: space.md },
  profile: { width: 40, height: 40, borderRadius: 20 },
  heroRow: { flexDirection: "row", gap: space.xl },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  fabWrap: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  fab: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.xl + 4,
    height: 58,
    borderRadius: radius.pill,
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
});
