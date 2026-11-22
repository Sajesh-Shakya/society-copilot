"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { updateTargetsAction } from "@/lib/dashboard/actions";

export function TargetsForm({ clubSlug, signupTarget, signupMin }: { clubSlug: string; signupTarget: number; signupMin: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [target, setTarget] = useState(String(signupTarget));
  const [min, setMin] = useState(String(signupMin));

  function save() {
    startTransition(async () => {
      const res = await updateTargetsAction(clubSlug, { signupTarget: Number(target), signupMin: Number(min) });
      if ("error" in res) toast.error(res.error);
      else {
        toast.success("Targets saved");
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-xs text-muted-foreground">
        Target per session
        <Input className="mt-1 w-28" inputMode="numeric" value={target} onChange={(e) => setTarget(e.target.value)} />
      </label>
      <label className="text-xs text-muted-foreground">
        Minimum
        <Input className="mt-1 w-28" inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value)} />
      </label>
      <Button size="sm" onClick={save} disabled={pending}>Save targets</Button>
    </div>
  );
}
