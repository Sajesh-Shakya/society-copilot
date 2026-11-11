import { createAdminClient } from "@/lib/supabase/admin";
import { EactivitiesNotConfiguredError } from "./types";

export interface EactivitiesCredentials {
  apiKey: string;
  cspCode: string;
}

export async function getEactivitiesCredentials(clubId: string): Promise<EactivitiesCredentials> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("club_credential")
    .select("credentials")
    .eq("club_id", clubId)
    .eq("provider", "eactivities")
    .maybeSingle();
  if (error) throw error;

  if (!data) {
    throw new EactivitiesNotConfiguredError(
      `No eActivities credentials configured for club ${clubId}. Run scripts/set-eactivities-credentials.ts for this club, or use CSV import instead.`
    );
  }

  const credentials = data.credentials as Partial<EactivitiesCredentials> | null;
  if (!credentials?.apiKey || !credentials?.cspCode) {
    throw new EactivitiesNotConfiguredError(
      `club_credential row for club ${clubId} (provider "eactivities") is missing apiKey or cspCode -- re-run scripts/set-eactivities-credentials.ts to fix it.`
    );
  }

  return { apiKey: credentials.apiKey, cspCode: credentials.cspCode };
}
