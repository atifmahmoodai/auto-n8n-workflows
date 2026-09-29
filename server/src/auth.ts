import { OAuth2Client } from "google-auth-library";

export type AuthenticatedUser = { userId: string; email: string | undefined };
export type TokenVerifier = (idToken: string) => Promise<AuthenticatedUser>;

/**
 * Verifies a Google ID token issued to one of our OAuth clients (web, iOS, Android).
 * Signature, expiry and issuer are checked by google-auth-library.
 */
export function createGoogleVerifier(audiences: string[]): TokenVerifier {
  if (audiences.length === 0) {
    throw new Error("GOOGLE_CLIENT_IDS must list at least one OAuth client ID");
  }
  const client = new OAuth2Client();
  return async (idToken) => {
    const ticket = await client.verifyIdToken({ idToken, audience: audiences });
    const payload = ticket.getPayload();
    if (!payload?.sub) throw new Error("ID token has no subject");
    if (payload.email && payload.email_verified === false) throw new Error("Email not verified");
    return { userId: payload.sub, email: payload.email };
  };
}
