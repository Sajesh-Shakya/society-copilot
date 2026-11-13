import { createClient } from "@/lib/supabase/server";

/**
 * Returns the signed-in user's lowercased email, or null when there is no
 * valid session. The JWT is verified locally (ES256 via cached JWKS) by
 * getClaims() rather than via a network round trip to the Auth server.
 * Never throws for an expired or garbled token.
 */
export async function getSignedInEmail(): Promise<string | null> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data?.claims) return null;
    const email = data.claims.email;
    return typeof email === "string" && email ? email.toLowerCase() : null;
  } catch {
    return null;
  }
}
