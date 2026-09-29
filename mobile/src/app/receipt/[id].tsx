import Ionicons from "@expo/vector-icons/Ionicons";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, Image, Linking, Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ItemRow, TotalLine } from "../../components/ItemRow";
import { Button, Card, Divider, EmptyState, MerchantAvatar, SyncBadge, Text } from "../../components/ui";
import { formatDate, formatMoney } from "../../lib/format";
import { removeReceipt } from "../../lib/receipts";
import { getSpreadsheetUrl } from "../../lib/sheets";
import { syncReceipt } from "../../lib/sync";
import { useReceipt } from "../../lib/useReceipts";
import { radius, space, useTheme } from "../../theme";

export default function ReceiptScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const receipt = useReceipt(id);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [photoOpen, setPhotoOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);

  if (receipt === undefined) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }
  if (receipt === null) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <EmptyState icon="document-outline" title="Receipt not found" body="It may have been deleted." />
      </View>
    );
  }

  const retrySync = async () => {
    setSyncing(true);
    await syncReceipt(receipt.id);
    setSyncing(false);
  };

  const openSheet = async () => {
    const url = await getSpreadsheetUrl();
    if (url) await Linking.openURL(url);
  };

  const confirmDelete = () =>
    Alert.alert(
      "Delete receipt?",
      "It will be removed from this device. Rows already added to your Google Sheet stay there.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            await removeReceipt(receipt.id);
            router.back();
          },
        },
      ],
    );

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable accessibilityLabel="Delete receipt" hitSlop={10} onPress={confirmDelete}>
              <Ionicons name="trash-outline" size={22} color={colors.danger} />
            </Pressable>
          ),
        }}
      />
      <ScrollView
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: insets.bottom + space.xxl }}
      >
        <View style={styles.hero}>
          <MerchantAvatar name={receipt.merchant} size={60} />
          <Text variant="title" style={{ textAlign: "center" }}>
            {receipt.merchant}
          </Text>
          <Text tone="muted">{formatDate(receipt.purchaseDate)}{receipt.paymentMethod ? ` · ${receipt.paymentMethod}` : ""}</Text>
          <Text variant="display" style={{ marginTop: space.sm }}>
            {formatMoney(receipt.total, receipt.currency)}
          </Text>
          <SyncBadge status={receipt.syncStatus} />
        </View>

        {receipt.syncStatus === "failed" ? (
          <Card style={{ gap: space.md, borderColor: colors.danger }}>
            <Text variant="caption" tone="danger">
              {receipt.syncError ?? "This receipt hasn't been added to Google Sheets yet."}
            </Text>
            <Button title="Retry sync" icon="refresh" variant="secondary" loading={syncing} onPress={() => void retrySync()} />
          </Card>
        ) : null}

        <Card style={{ paddingVertical: space.sm }}>
          <View style={{ paddingVertical: space.sm }}>
            <Text variant="headline">
              {receipt.items.length} item{receipt.items.length === 1 ? "" : "s"}
            </Text>
          </View>
          {receipt.items.map((item, index) => (
            <View key={item.id}>
              {index > 0 ? <Divider /> : null}
              <ItemRow item={item} currency={receipt.currency} />
            </View>
          ))}
        </Card>

        <Card style={{ gap: space.xs }}>
          {receipt.subtotal !== null ? <TotalLine label="Items" value={formatMoney(receipt.subtotal, receipt.currency)} /> : null}
          {receipt.tax !== null ? <TotalLine label="Tax" value={formatMoney(receipt.tax, receipt.currency)} /> : null}
          <Divider />
          <TotalLine label="Total" value={formatMoney(receipt.total, receipt.currency)} strong />
        </Card>

        <View style={{ flexDirection: "row", gap: space.md }}>
          {receipt.imageUri ? (
            <Button title="View photo" icon="image-outline" variant="secondary" style={{ flex: 1 }} onPress={() => setPhotoOpen(true)} />
          ) : null}
          {receipt.syncStatus === "synced" ? (
            <Button title="Open Sheet" icon="open-outline" variant="secondary" style={{ flex: 1 }} onPress={() => void openSheet()} />
          ) : null}
        </View>
      </ScrollView>

      {receipt.imageUri ? (
        <Modal visible={photoOpen} animationType="fade" onRequestClose={() => setPhotoOpen(false)}>
          <View style={styles.photoModal}>
            <Image source={{ uri: receipt.imageUri }} style={{ flex: 1 }} resizeMode="contain" />
            <Pressable
              accessibilityLabel="Close photo"
              onPress={() => setPhotoOpen(false)}
              style={[styles.close, { top: insets.top + space.md }]}
            >
              <Ionicons name="close" size={24} color="#fff" />
            </Pressable>
          </View>
        </Modal>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  hero: { alignItems: "center", gap: space.xs, paddingVertical: space.md },
  photoModal: { flex: 1, backgroundColor: "#000" },
  close: {
    position: "absolute",
    right: space.lg,
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
});
