import Ionicons from "@expo/vector-icons/Ionicons";
import Constants from "expo-constants";
import { useEffect, useState } from "react";
import { Alert, Image, Linking, ScrollView, StyleSheet, View } from "react-native";
import { Button, Card, Divider, Text, type IconName } from "../components/ui";
import { useAuth } from "../lib/auth";
import { getSpreadsheetUrl } from "../lib/sheets";
import { syncAllPending } from "../lib/sync";
import { useReceiptList } from "../lib/useReceipts";
import { radius, space, useTheme } from "../theme";

function InfoRow({ icon, label, value }: { icon: IconName; label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.infoRow}>
      <Ionicons name={icon} size={20} color={colors.textMuted} />
      <Text style={{ flex: 1 }}>{label}</Text>
      <Text tone="muted">{value}</Text>
    </View>
  );
}

export default function SettingsScreen() {
  const { user, signOut } = useAuth();
  const { colors } = useTheme();
  const { receipts } = useReceiptList();
  const [sheetUrl, setSheetUrl] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const unsynced = receipts?.filter((r) => r.syncStatus !== "synced").length ?? 0;

  useEffect(() => {
    void getSpreadsheetUrl().then(setSheetUrl);
  }, [receipts]);

  const syncNow = async () => {
    setSyncing(true);
    const { synced, failed } = await syncAllPending();
    setSyncing(false);
    if (failed > 0) Alert.alert("Some receipts didn't sync", `${synced} synced, ${failed} failed. Open a receipt to see why.`);
  };

  const confirmSignOut = () =>
    Alert.alert(
      "Sign out?",
      unsynced > 0
        ? `${unsynced} receipt${unsynced > 1 ? "s haven't" : " hasn't"} been synced yet. They stay on this device and sync when you sign back in with the same account.`
        : "Your receipts stay on this device and in your Google Sheet.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Sign out", style: "destructive", onPress: () => void signOut() },
      ],
    );

  return (
    <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
      <Card style={styles.account}>
        {user?.photo ? (
          <Image source={{ uri: user.photo }} style={styles.photo} />
        ) : (
          <View style={[styles.photo, { backgroundColor: colors.accentSoft, alignItems: "center", justifyContent: "center" }]}>
            <Ionicons name="person" size={26} color={colors.accent} />
          </View>
        )}
        <View style={{ flex: 1 }}>
          <Text variant="headline">{user?.name ?? "Google account"}</Text>
          <Text tone="muted" variant="caption">
            {user?.email}
          </Text>
        </View>
      </Card>

      <Text variant="overline" tone="faint">
        Google Sheets
      </Text>
      <Card style={{ gap: space.md }}>
        <InfoRow icon="receipt-outline" label="Receipts saved" value={String(receipts?.length ?? 0)} />
        <Divider />
        <InfoRow icon="cloud-upload-outline" label="Waiting to sync" value={String(unsynced)} />
        {unsynced > 0 ? <Button title="Sync now" icon="sync" variant="secondary" loading={syncing} onPress={() => void syncNow()} /> : null}
        {sheetUrl ? (
          <Button title="Open my spreadsheet" icon="open-outline" onPress={() => void Linking.openURL(sheetUrl)} />
        ) : (
          <Text variant="caption" tone="muted">
            Your “Tally Receipts” spreadsheet is created in Google Drive when you save your first receipt.
          </Text>
        )}
      </Card>

      <Text variant="overline" tone="faint">
        About
      </Text>
      <Card style={{ gap: space.md }}>
        <InfoRow icon="information-circle-outline" label="Version" value={Constants.expoConfig?.version ?? "1.0.0"} />
        <Divider />
        <Text variant="caption" tone="muted">
          Receipt photos are stored on this device. To read a receipt, the photo is sent securely to our server and processed by
          an AI model; it is not kept after processing.
        </Text>
      </Card>

      <Button title="Sign out" variant="danger" icon="log-out-outline" onPress={confirmSignOut} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  account: { flexDirection: "row", alignItems: "center", gap: space.lg },
  photo: { width: 56, height: 56, borderRadius: radius.pill },
  infoRow: { flexDirection: "row", alignItems: "center", gap: space.md },
});
