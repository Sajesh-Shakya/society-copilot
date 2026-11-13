import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export const createClient = async (
  request: NextRequest
): Promise<{ supabaseResponse: NextResponse; email: string | null }> => {
  let supabaseResponse = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  const supabase = createServerClient(supabaseUrl!, supabaseKey!, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options)
        );
      },
    },
  });

  // getClaims() verifies the JWT locally and first refreshes the session when
  // the access token is expired/about to expire (the refreshed cookies flow
  // through setAll above) — do not remove, even though the result is used too.
  let email: string | null = null;
  try {
    const { data, error } = await supabase.auth.getClaims();
    const claimEmail = data?.claims?.email;
    if (!error && typeof claimEmail === "string" && claimEmail) {
      email = claimEmail.toLowerCase();
    }
  } catch {
    email = null;
  }

  return { supabaseResponse, email };
};
