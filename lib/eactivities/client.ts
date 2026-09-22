import { EactivitiesApiError, EactivitiesNotConfiguredError } from "./types";

const BASE_URL = "https://eactivities.union.ic.ac.uk/API";

/**
 * Thin fetch wrapper for the eActivities API. Deliberately has NO retry
 * logic of any kind: a 401 means bad/missing credentials (retrying without
 * fixing that just wastes the request budget), and a 403 means the
 * requesting IP is already rate-limited or banned (1hr for repeated auth
 * failures, 5min for request volume) — retrying a 403 risks extending an
 * IP-wide ban that affects the whole app, not just this call.
 * See core/INTEGRATIONS.md and design.md's Architecture Decisions.
 */
export async function eactivitiesFetch<T>(path: string): Promise<T> {
  const apiKey = process.env.EACTIVITIES_API_KEY;
  if (!apiKey) throw new EactivitiesNotConfiguredError("EACTIVITIES_API_KEY");

  const response = await fetch(`${BASE_URL}${path}`, {
    method: "GET",
    headers: {
      "X-API-Key": apiKey,
      Accept: "application/json",
    },
  });

  if (response.ok) {
    return (await response.json()) as T;
  }

  if (response.status === 401 || response.status === 403) {
    let apiMessage = "";
    try {
      const body = (await response.json()) as { message?: string };
      apiMessage = body.message ?? "";
    } catch {
      // body wasn't JSON — fall through with an empty message
    }
    throw new EactivitiesApiError(response.status, apiMessage);
  }

  throw new Error(
    `eActivities API returned unexpected status ${response.status} for ${path}`
  );
}

export function cspPath(path: string): string {
  const centre = process.env.EACTIVITIES_CSP_CODE;
  if (!centre) throw new EactivitiesNotConfiguredError("EACTIVITIES_CSP_CODE");
  return `/csp/${centre}${path}`;
}
