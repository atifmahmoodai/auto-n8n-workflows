import {
  GoogleSignin,
  statusCodes,
  type SignInResponse,
  type User,
} from "@react-native-google-signin/google-signin";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Platform } from "react-native";
import { config } from "./config";
import { clearAllData, getSetting, setSetting } from "./db";
import { deleteAllReceiptImages } from "./image";

/** Lets the app create and edit only the spreadsheets it creates itself (not the user's other files). */
export const SHEETS_SCOPE = "https://www.googleapis.com/auth/drive.file";

type AuthStatus = "loading" | "signedOut" | "signedIn";

type AuthContextValue = {
  status: AuthStatus;
  user: User["user"] | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

let configured = false;
function configure() {
  if (configured) return;
  GoogleSignin.configure({
    webClientId: config.googleWebClientId,
    ...(Platform.OS === "ios" && config.googleIosClientId ? { iosClientId: config.googleIosClientId } : {}),
    scopes: [SHEETS_SCOPE],
  });
  configured = true;
}

export class AuthError extends Error {}

/** Sign-in error codes that mean the user simply backed out. */
export function isCancellation(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === statusCodes.SIGN_IN_CANCELLED;
}

async function handleSignedIn(response: SignInResponse): Promise<User | null> {
  if (response.type !== "success") return null;
  let user = response.data;
  // Google's consent screen lets users untick scopes; ask again for the Sheets one if missing.
  if (!user.scopes.includes(SHEETS_SCOPE)) {
    const granted = await GoogleSignin.addScopes({ scopes: [SHEETS_SCOPE] });
    if (granted?.type === "success") user = granted.data;
  }
  // Receipts are per account: wipe local data if a different Google account signs in.
  const previousUserId = await getSetting("userId");
  if (previousUserId && previousUserId !== user.user.id) {
    await clearAllData();
    deleteAllReceiptImages();
  }
  await setSetting("userId", user.user.id);
  return user;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<User["user"] | null>(null);

  useEffect(() => {
    configure();
    let cancelled = false;
    (async () => {
      try {
        if (GoogleSignin.hasPreviousSignIn()) {
          const response = await GoogleSignin.signInSilently();
          if (!cancelled && response.type === "success") {
            setUser(response.data.user);
            setStatus("signedIn");
            return;
          }
        }
      } catch (error) {
        console.warn("Silent sign-in failed", error);
      }
      if (!cancelled) setStatus("signedOut");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async () => {
    configure();
    if (Platform.OS === "android") await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    const signedIn = await handleSignedIn(await GoogleSignin.signIn());
    if (signedIn) {
      setUser(signedIn.user);
      setStatus("signedIn");
    }
  }, []);

  const signOut = useCallback(async () => {
    await GoogleSignin.signOut();
    setUser(null);
    setStatus("signedOut");
  }, []);

  const value = useMemo(() => ({ status, user, signIn, signOut }), [status, user, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

/**
 * Runs `request` with fresh Google tokens. Cached tokens can be expired (notably ID tokens on
 * Android), so on a 401 we drop the cache, re-authenticate silently and retry once.
 */
export async function withGoogleTokens<T>(
  request: (tokens: { idToken: string; accessToken: string }) => Promise<T>,
  isUnauthorized: (error: unknown) => boolean,
): Promise<T> {
  configure();
  let tokens;
  try {
    tokens = await GoogleSignin.getTokens();
  } catch {
    throw new AuthError("You're signed out. Please sign in again.");
  }
  try {
    return await request(tokens);
  } catch (error) {
    if (!isUnauthorized(error)) throw error;
    await GoogleSignin.clearCachedAccessToken(tokens.accessToken);
    const refreshed = await GoogleSignin.signInSilently();
    if (refreshed.type !== "success") throw new AuthError("Your session expired. Please sign in again.");
    return request(await GoogleSignin.getTokens());
  }
}
