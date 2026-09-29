import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { AppState } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider, useAuth } from "../lib/auth";
import { syncAllPending } from "../lib/sync";
import { useTheme } from "../theme";

void SplashScreen.preventAutoHideAsync();

function BackgroundSync() {
  const { status } = useAuth();
  useEffect(() => {
    if (status !== "signedIn") return;
    void syncAllPending();
    // Retry anything that failed (e.g. offline) whenever the app comes back to the foreground.
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void syncAllPending();
    });
    return () => sub.remove();
  }, [status]);
  return null;
}

function RootStack() {
  const { status } = useAuth();
  const { colors, scheme } = useTheme();

  useEffect(() => {
    if (status !== "loading") void SplashScreen.hideAsync();
  }, [status]);

  if (status === "loading") return null;

  return (
    <>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      <BackgroundSync />
      <Stack
        screenOptions={{
          headerShadowVisible: false,
          headerStyle: { backgroundColor: colors.background },
          headerTintColor: colors.text,
          headerTitleStyle: { fontWeight: "600" },
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Protected guard={status === "signedIn"}>
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="scan" options={{ headerShown: false, presentation: "fullScreenModal", animation: "fade" }} />
          <Stack.Screen name="review" options={{ title: "Review receipt", headerBackTitle: "Back" }} />
          <Stack.Screen name="receipt/[id]" options={{ title: "", headerBackTitle: "Receipts" }} />
          <Stack.Screen name="settings" options={{ title: "Settings", presentation: "modal" }} />
        </Stack.Protected>
        <Stack.Protected guard={status === "signedOut"}>
          <Stack.Screen name="sign-in" options={{ headerShown: false }} />
        </Stack.Protected>
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <RootStack />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
