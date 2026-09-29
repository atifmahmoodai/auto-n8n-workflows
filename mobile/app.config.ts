import type { ExpoConfig } from "expo/config";

// Google Sign-In on iOS needs the reversed iOS client ID as a URL scheme.
// e.g. 1234-abc.apps.googleusercontent.com -> com.googleusercontent.apps.1234-abc
const iosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? "";
const iosUrlScheme = iosClientId
  ? `com.googleusercontent.apps.${iosClientId.replace(".apps.googleusercontent.com", "")}`
  : "com.googleusercontent.apps.REPLACE_ME";

const config: ExpoConfig = {
  name: "Tally",
  slug: "tally-receipts",
  scheme: "tally",
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  ios: {
    supportsTablet: false,
    bundleIdentifier: process.env.IOS_BUNDLE_ID ?? "com.example.tally",
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: process.env.ANDROID_PACKAGE ?? "com.example.tally",
    adaptiveIcon: {
      backgroundColor: "#0B0F14",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    "expo-router",
    "expo-sqlite",
    "expo-secure-store",
    [
      "expo-splash-screen",
      {
        image: "./assets/splash-icon.png",
        imageWidth: 160,
        backgroundColor: "#F5F6F8",
        dark: { backgroundColor: "#0B0F14" },
      },
    ],
    [
      "expo-camera",
      {
        cameraPermission: "Tally uses the camera to photograph your receipts.",
        recordAudioAndroid: false,
      },
    ],
    [
      "expo-image-picker",
      {
        photosPermission: "Tally lets you import receipt photos from your library.",
        cameraPermission: "Tally uses the camera to photograph your receipts.",
      },
    ],
    ["@react-native-google-signin/google-signin", { iosUrlScheme }],
    "expo-build-properties",
  ],
  experiments: {
    typedRoutes: true,
  },
};

export default config;
