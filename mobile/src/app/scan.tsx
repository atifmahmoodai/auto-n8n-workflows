import Ionicons from "@expo/vector-icons/Ionicons";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { useRef, useState } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button, Text } from "../components/ui";
import { space, useTheme } from "../theme";

function goToReview(uri: string, width: number, height: number) {
  router.replace({ pathname: "/review", params: { uri, width: String(width), height: String(height) } });
}

async function pickFromLibrary() {
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1 });
  if (!result.canceled && result.assets[0]) {
    const asset = result.assets[0];
    goToReview(asset.uri, asset.width, asset.height);
  }
}

function PermissionGate({ canAskAgain, onRequest }: { canAskAgain: boolean; onRequest: () => void }) {
  const { colors } = useTheme();
  return (
    <SafeAreaView style={[styles.permission, { backgroundColor: colors.background }]}>
      <View style={{ alignItems: "flex-end" }}>
        <Pressable accessibilityLabel="Close" onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="close" size={28} color={colors.text} />
        </Pressable>
      </View>
      <View style={{ gap: space.md, alignItems: "center" }}>
        <Ionicons name="camera-outline" size={48} color={colors.accent} />
        <Text variant="title" style={{ textAlign: "center" }}>
          Camera access needed
        </Text>
        <Text tone="muted" style={{ textAlign: "center" }}>
          Tally uses your camera to photograph receipts. Photos stay on your device and are only sent to read the items.
        </Text>
      </View>
      <View style={{ gap: space.sm }}>
        {canAskAgain ? (
          <Button title="Allow camera" onPress={onRequest} />
        ) : (
          <Button title="Open Settings" onPress={() => void Linking.openSettings()} />
        )}
        <Button title="Choose from library" variant="secondary" icon="images-outline" onPress={() => void pickFromLibrary()} />
      </View>
    </SafeAreaView>
  );
}

export default function ScanScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [ready, setReady] = useState(false);
  const [torch, setTorch] = useState(false);
  const [capturing, setCapturing] = useState(false);

  if (!permission) return <View style={{ flex: 1, backgroundColor: "#000" }} />;
  if (!permission.granted) {
    return <PermissionGate canAskAgain={permission.canAskAgain} onRequest={() => void requestPermission()} />;
  }

  const capture = async () => {
    if (!camera.current || !ready || capturing) return;
    setCapturing(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      const photo = await camera.current.takePictureAsync({ quality: 0.9, skipProcessing: false });
      goToReview(photo.uri, photo.width, photo.height);
    } catch (error) {
      console.warn("Capture failed", error);
      Alert.alert("Couldn't take photo", "Please try again.");
      setCapturing(false);
    }
  };

  return (
    <View style={styles.container}>
      <CameraView
        ref={camera}
        style={StyleSheet.absoluteFill}
        facing="back"
        enableTorch={torch}
        onCameraReady={() => setReady(true)}
        onMountError={(e) => Alert.alert("Camera unavailable", e.message)}
      />
      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        <View style={styles.topBar}>
          <RoundButton icon="close" label="Close" onPress={() => router.back()} />
          <Text variant="bodyStrong" style={{ color: "#fff" }}>
            Fit the whole receipt in the frame
          </Text>
          <RoundButton icon={torch ? "flash" : "flash-off"} label="Toggle flash" onPress={() => setTorch((t) => !t)} />
        </View>

        <View style={styles.frame} pointerEvents="none">
          {(["tl", "tr", "bl", "br"] as const).map((corner) => (
            <View key={corner} style={[styles.corner, styles[corner]]} />
          ))}
        </View>

        <View style={styles.bottomBar}>
          <RoundButton icon="images-outline" label="Choose from library" onPress={() => void pickFromLibrary()} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Take photo"
            onPress={() => void capture()}
            disabled={!ready || capturing}
            style={({ pressed }) => [styles.shutter, { opacity: ready ? 1 : 0.5, transform: [{ scale: pressed ? 0.94 : 1 }] }]}
          >
            {capturing ? <ActivityIndicator color="#0B0F14" /> : <View style={styles.shutterInner} />}
          </Pressable>
          <View style={{ width: 48 }} />
        </View>
      </SafeAreaView>
    </View>
  );
}

function RoundButton({ icon, label, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={8} style={styles.round}>
      <Ionicons name={icon} size={22} color="#fff" />
    </Pressable>
  );
}

const CORNER = 34;
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  overlay: { flex: 1, justifyContent: "space-between" },
  topBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.lg, paddingTop: space.sm },
  frame: { flex: 1, marginHorizontal: space.xl, marginVertical: space.xl },
  corner: { position: "absolute", width: CORNER, height: CORNER, borderColor: "#fff" },
  tl: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 14 },
  tr: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 14 },
  bl: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 14 },
  br: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 14 },
  bottomBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.xl, paddingBottom: space.lg },
  round: { width: 48, height: 48, borderRadius: 24, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center" },
  shutter: { width: 78, height: 78, borderRadius: 39, borderWidth: 4, borderColor: "#fff", alignItems: "center", justifyContent: "center" },
  shutterInner: { width: 62, height: 62, borderRadius: 31, backgroundColor: "#fff" },
  permission: { flex: 1, padding: space.xl, justifyContent: "space-between" },
});
