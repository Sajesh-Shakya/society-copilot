// eActivities API types — field names match the real API (PascalCase) since
// this file is the adapter boundary; callers get camelCase from provider.ts.
// See core/INTEGRATIONS.md "Real API reference" for the source spec.

export interface WhatsOnEvent {
  ID: string;
  Title: string;
  Description: string;
  EventStart: string; // ISO datetime
  EventEnd: string;
  Location: string;
  PostCode: string;
  EventType: string;
  Active: boolean;
}

export interface SignupSummary {
  ID: string;
  Title: string;
  Description: string;
  SignupOpen: string;
  SignupClose: string;
  AttendeesCount: number;
  MaximumAttendees: number;
}

// GET /csp/{centre}/whatson/{id}
export interface WhatsOnEventDetail extends WhatsOnEvent {
  Signups: SignupSummary[];
}

export interface Attendee {
  FirstName: string;
  Surname: string;
  CID: string | null; // 8-digit Imperial student ID; may be absent for non-Imperial attendees
  Email: string;
  Login: string | null; // shortcode, e.g. 'jbloggs50'
}

// GET /csp/{centre}/signups/{id}
export interface SignupDetail extends SignupSummary {
  Attendees: Attendee[];
}

export class EactivitiesApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly apiMessage: string
  ) {
    super(`eActivities API error (${status}): ${apiMessage}`);
    this.name = "EactivitiesApiError";
  }
}

export class EactivitiesNotConfiguredError extends Error {
  constructor(missingVar: string) {
    super(
      `${missingVar} is not set. See core/INTEGRATIONS.md "Real API reference" ` +
        `for what's needed — EACTIVITIES_API_KEY and EACTIVITIES_CSP_CODE must ` +
        `both be set in .env.local before any eActivities call can succeed.`
    );
    this.name = "EactivitiesNotConfiguredError";
  }
}
