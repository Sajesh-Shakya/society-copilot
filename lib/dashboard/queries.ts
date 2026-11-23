import { createClubScopedClient } from "@/lib/supabase/club-scoped";
import { createAdminClient } from "@/lib/supabase/admin";

export interface SessionSignup {
  sessionId: string;
  title: string;
  startsAt: string;
  signups: number;
  attended: number;
}

export interface RevenueRow {
  productId: string;
  productName: string;
  purchases: number;
  unpriced: number;
  revenuePence: number;
}

export interface DashboardData {
  signups: SessionSignup[];
  averageSignups: number | null;
  averageAttended: number | null;
  revenue: RevenueRow[];
  totalRevenuePence: number;
  unpricedPurchases: number;
  owed: {
    sessions: number;
    people: number;
    buckets: { d0_14: number; d15_30: number; d31plus: number };
  };
  singleSessionPrices: number[];
  targets: { signupTarget: number; signupMin: number };
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Every total comes from SQL (PostgREST caps responses at 1000 rows).
export async function getDashboard(clubId: string, range: { start: Date; end: Date }): Promise<DashboardData> {
  const scoped = createClubScopedClient(clubId);
  const rangeArgs = { range_start: range.start.toISOString(), range_end: range.end.toISOString() };

  const [signupsRes, revenueRes, owedRes, pricesRes, clubRes] = await Promise.all([
    scoped.rpc("dashboard_signups", rangeArgs),
    scoped.rpc("dashboard_revenue", rangeArgs),
    scoped.rpc("dashboard_money_owed"),
    scoped
      .from("product")
      .select("price_pence")
      .eq("active", true)
      .eq("kind", "session_pass")
      .eq("covers_sessions", 1)
      .not("price_pence", "is", null),
    createAdminClient().from("club").select("signup_target, signup_min").eq("id", clubId).single(),
  ]);
  for (const res of [signupsRes, revenueRes, owedRes, pricesRes, clubRes]) {
    if (res.error) throw new Error(`getDashboard: ${res.error.message}`);
  }

  const signups: SessionSignup[] = (signupsRes.data as {
    session_id: string; title: string; starts_at: string; signups: number; attended: number;
  }[]).map((r) => ({
    sessionId: r.session_id,
    title: r.title,
    startsAt: r.starts_at,
    signups: Number(r.signups),
    attended: Number(r.attended),
  })).filter((s) => s.signups > 0); // sessions nobody signed up to aren't real sessions

  const revenue: RevenueRow[] = (revenueRes.data as {
    product_id: string; product_name: string; purchases: number; unpriced: number; revenue_pence: number;
  }[]).map((r) => ({
    productId: r.product_id,
    productName: r.product_name,
    purchases: Number(r.purchases),
    unpriced: Number(r.unpriced),
    revenuePence: Number(r.revenue_pence),
  }));

  const o = (owedRes.data as {
    sessions: number; people: number; bucket_0_14: number; bucket_15_30: number; bucket_31_plus: number;
  }[])[0];

  const club = clubRes.data as { signup_target: number; signup_min: number };

  return {
    signups,
    averageSignups: mean(signups.map((s) => s.signups)),
    averageAttended: mean(signups.map((s) => s.attended)),
    revenue,
    totalRevenuePence: revenue.reduce((a, r) => a + r.revenuePence, 0),
    unpricedPurchases: revenue.reduce((a, r) => a + r.unpriced, 0),
    owed: {
      sessions: Number(o?.sessions ?? 0),
      people: Number(o?.people ?? 0),
      buckets: {
        d0_14: Number(o?.bucket_0_14 ?? 0),
        d15_30: Number(o?.bucket_15_30 ?? 0),
        d31plus: Number(o?.bucket_31_plus ?? 0),
      },
    },
    singleSessionPrices: ((pricesRes.data ?? []) as unknown as { price_pence: number }[]).map((p) => p.price_pence),
    targets: { signupTarget: club.signup_target, signupMin: club.signup_min },
  };
}
