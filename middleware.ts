import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  const { supabaseResponse, user } = await createClient(request);

  if (!user) {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  return supabaseResponse;
}

// Only /sessions/* needs a logged-in user at the page level. /login and
// /auth/callback must stay reachable while signed out (that's the whole
// point). The API routes under /api/cron and /api/sessions/[id]/sync have
// their own CRON_SECRET/SYNC_TRIGGER_SECRET auth and must not be matched
// here.
export const config = {
  matcher: ["/sessions/:path*"],
};
