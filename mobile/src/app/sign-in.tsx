import Ionicons from "@expo/vector-icons/Ionicons";
import { LinearGradient } from "expo-linear-gradient";
import { useState } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button, Text, type IconName } from "../components/ui";
import { isCancellation, useAuth } from "../lib/auth";
import { missingConfig } from "../lib/config";
import { radius, space, useTheme } from "../theme";

const FEATURES: { icon: IconName; title: string; body: string }[] = [
  { icon: "scan-outline", title: "Snap any receipt", body: "Groceries, pharmacy, fuel, dining: every line item is read for you." },
  { icon: "list-outline", title: "Every item and price", body: "Review and fix the extracted items before saving." },
  { icon: "grid-outline", title: "Lands in Google Sheets", body: "Each receipt is added to a spreadsheet in your own Google Drive." },
];

export default function SignInScreen() {
  const { signIn } = useAuth();
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);

  const onSignIn = async () => {
    const missing = missingConfig();
    if (missing.length) {
      Alert.alert("App not configured", `Set ${missing.join(", ")} in .env and rebuild.`);
      return;
    }
    setBusy(true);
    try {
      await signIn();
    } catch (error) {
      if (!isCancellation(error)) {
        console.warn("Sign-in failed", error);
        Alert.alert("Sign-in failed", "We couldn't sign you in with Google. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.top}>
        <LinearGradient colors={[colors.heroFrom, colors.heroTo]} style={styles.logo}>
          <Ionicons name="receipt-outline" size={34} color="#FFFFFF" />
        </LinearGradient>
        <Text variant="display" style={{ textAlign: "center" }}>
          Tally
        </Text>
        <Text tone="muted" style={{ textAlign: "center", fontSize: 17 }}>
          Your receipts, itemised and organised.
        </Text>
      </View>

      <View style={styles.features}>
        {FEATURES.map((f) => (
          <View key={f.title} style={styles.feature}>
            <View style={[styles.featureIcon, { backgroundColor: colors.accentSoft }]}>
              <Ionicons name={f.icon} size={22} color={colors.accent} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="bodyStrong">{f.title}</Text>
              <Text tone="muted" variant="caption">
                {f.body}
              </Text>
            </View>
          </View>
        ))}
      </View>

      <View style={{ gap: space.md }}>
        <Button title="Continue with Google" icon="logo-google" onPress={onSignIn} loading={busy} />
        <Text tone="faint" variant="caption" style={{ textAlign: "center" }}>
          Tally can only see the spreadsheet it creates, not your other Drive files.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: space.xl, paddingBottom: space.lg, justifyContent: "space-between" },
  top: { alignItems: "center", gap: space.md, marginTop: space.xxl * 1.5 },
  logo: { width: 76, height: 76, borderRadius: radius.xl, alignItems: "center", justifyContent: "center", marginBottom: space.sm },
  features: { gap: space.xl },
  feature: { flexDirection: "row", gap: space.lg, alignItems: "center" },
  featureIcon: { width: 46, height: 46, borderRadius: radius.md, alignItems: "center", justifyContent: "center" },
});
