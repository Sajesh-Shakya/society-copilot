import { cspPath, eactivitiesFetch } from "./client";
import type { SignupDetail, WhatsOnEvent, WhatsOnEventDetail } from "./types";

/**
 * Implements the eActivities-backed subset of SocietyDataProvider needed by
 * the attendance-tracking feature (see core/INTEGRATIONS.md). Only
 * event/signup methods are implemented here — getProducts/getProductSales
 * are gone (deprecated; Pluto/XLSX cover that domain, see the
 * Purchase-ingestion adapter), and committee/member/transaction methods
 * aren't needed by this feature so aren't built yet.
 */
export class EactivitiesProvider {
  async getEvents(): Promise<WhatsOnEvent[]> {
    return eactivitiesFetch<WhatsOnEvent[]>(cspPath("/whatson"));
  }

  async getEvent(eventId: string): Promise<WhatsOnEventDetail> {
    return eactivitiesFetch<WhatsOnEventDetail>(cspPath(`/whatson/${eventId}`));
  }

  async getSignup(signupId: string): Promise<SignupDetail> {
    return eactivitiesFetch<SignupDetail>(cspPath(`/signups/${signupId}`));
  }
}
