"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { approveChase, sendChase, rejectChase } from "@/lib/chase/actions";

export function ApprovalActions({ chaseEmailId, status }: { chaseEmailId: string; status: string }) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");

  async function handleApprove() {
    setIsLoading(true);
    try {
      const result = await approveChase(chaseEmailId);
      if (result.approved) {
        toast.success("Approved.");
        router.refresh();
      } else {
        toast.error("Could not approve -- this draft may have already been actioned.");
      }
    } catch {
      toast.error("Approve failed.");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSend() {
    setIsLoading(true);
    try {
      const result = await sendChase(chaseEmailId);
      if (result.sent) {
        toast.success("Sent.");
      } else {
        toast.error(`Not sent -- ${result.reason === "exempt" ? "person is now exempt" : "debt was already cleared"}.`);
      }
      router.refresh();
    } catch {
      toast.error("Send failed.");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleReject() {
    if (!note.trim()) {
      toast.error("A note is required to reject a draft.");
      return;
    }
    setIsLoading(true);
    try {
      const result = await rejectChase(chaseEmailId, note.trim());
      if (result.rejected) {
        toast.success("Rejected.");
        setRejecting(false);
        setNote("");
        router.refresh();
      } else {
        toast.error("Could not reject -- this draft may have already been actioned.");
      }
    } catch {
      toast.error("Reject failed.");
    } finally {
      setIsLoading(false);
    }
  }

  if (rejecting) {
    return (
      <div className="flex flex-col gap-2">
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Why is this being rejected? (required)"
          disabled={isLoading}
          rows={2}
        />
        <div className="flex gap-2">
          <Button type="button" variant="destructive" size="sm" disabled={isLoading} onClick={handleReject}>
            Confirm reject
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={isLoading} onClick={() => setRejecting(false)}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2">
      {status === "pending_approval" && (
        <Button type="button" size="sm" disabled={isLoading} onClick={handleApprove}>
          Approve
        </Button>
      )}
      {status === "approved" && (
        <Button type="button" size="sm" disabled={isLoading} onClick={handleSend}>
          Send
        </Button>
      )}
      <Button type="button" variant="outline" size="sm" disabled={isLoading} onClick={() => setRejecting(true)}>
        Reject
      </Button>
    </div>
  );
}
