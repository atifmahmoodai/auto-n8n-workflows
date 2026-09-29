import { useColorScheme } from "react-native";

const palette = {
  light: {
    background: "#F5F6F8",
    surface: "#FFFFFF",
    surfaceMuted: "#EEF0F3",
    border: "#E3E6EB",
    text: "#0B0F14",
    textMuted: "#5B6472",
    textFaint: "#8A93A1",
    accent: "#0F9D74",
    accentPressed: "#0B7F5E",
    accentSoft: "#E3F5EF",
    onAccent: "#FFFFFF",
    danger: "#D6453D",
    dangerSoft: "#FCE9E7",
    warning: "#B7791F",
    warningSoft: "#FDF3E1",
    heroFrom: "#0F2A22",
    heroTo: "#0B1512",
    overlay: "rgba(11,15,20,0.45)",
  },
  dark: {
    background: "#0B0F14",
    surface: "#141A21",
    surfaceMuted: "#1B222B",
    border: "#252E39",
    text: "#F2F4F7",
    textMuted: "#A3ACB9",
    textFaint: "#6E7887",
    accent: "#2BC89A",
    accentPressed: "#22A882",
    accentSoft: "#10352A",
    onAccent: "#04140F",
    danger: "#FF6B61",
    dangerSoft: "#3A1715",
    warning: "#F2B84B",
    warningSoft: "#3A2B10",
    heroFrom: "#15392E",
    heroTo: "#0E1A16",
    overlay: "rgba(0,0,0,0.6)",
  },
} as const;

export type Colors = { [K in keyof (typeof palette)["light"]]: string };

export const radius = { sm: 10, md: 14, lg: 20, xl: 28, pill: 999 } as const;
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export const type = {
  display: { fontSize: 34, fontWeight: "700", letterSpacing: -0.8 },
  title: { fontSize: 22, fontWeight: "700", letterSpacing: -0.4 },
  headline: { fontSize: 17, fontWeight: "600", letterSpacing: -0.2 },
  body: { fontSize: 15, fontWeight: "400" },
  bodyStrong: { fontSize: 15, fontWeight: "600" },
  caption: { fontSize: 13, fontWeight: "500" },
  overline: { fontSize: 12, fontWeight: "600", letterSpacing: 0.8, textTransform: "uppercase" },
} as const;

export function useTheme() {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  return { colors: palette[scheme] as Colors, scheme };
}
