// Note written when processAutoSends cancels a standing-approval row because
// the approval was revoked / the person became exempt. The generator treats
// such a cancelled row as "never actioned" so chasing continues (as a normal
// pending_approval draft) instead of silently stopping for the debt cycle.
export const STANDING_CANCEL_NOTE = "Auto-cancelled: standing approval no longer valid before send.";
