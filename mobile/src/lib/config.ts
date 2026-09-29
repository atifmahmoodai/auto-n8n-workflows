// EXPO_PUBLIC_* variables are inlined at build time (see .env.example).
export const config = {
  apiUrl: (process.env.EXPO_PUBLIC_API_URL ?? "").replace(/\/+$/, ""),
  googleWebClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? "",
  googleIosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? "",
};

export function missingConfig(): string[] {
  const missing: string[] = [];
  if (!config.apiUrl) missing.push("EXPO_PUBLIC_API_URL");
  if (!config.googleWebClientId) missing.push("EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID");
  return missing;
}
