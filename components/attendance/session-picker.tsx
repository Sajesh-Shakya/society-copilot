"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getEventSignups, createSessionFromSignup } from "@/lib/attendance/actions";

interface EventOption {
  id: string;
  title: string;
  startsAt: string;
}

interface SignupOption {
  id: string;
  title: string;
  attendeesCount: number;
  maximumAttendees: number;
}

// Formats an eActivities datetime string for the <input type="datetime-local">
// value attribute (no timezone suffix, minute precision).
function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function SessionPicker({ events }: { events: EventOption[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [eventId, setEventId] = useState<string>("");
  const [signups, setSignups] = useState<SignupOption[] | null>(null);
  const [signupId, setSignupId] = useState<string>("");
  const [title, setTitle] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [loadingSignups, setLoadingSignups] = useState(false);

  async function handleEventChange(id: string) {
    setEventId(id);
    setSignupId("");
    setSignups(null);
    const event = events.find((e) => e.id === id);
    if (event) {
      setTitle(event.title);
      setStartsAt(toDatetimeLocal(event.startsAt));
    }
    setLoadingSignups(true);
    try {
      const detail = await getEventSignups(id);
      setSignups(detail.signups);
    } catch {
      toast.error("Couldn't load this event's signups from eActivities.");
      setSignups([]);
    } finally {
      setLoadingSignups(false);
    }
  }

  function handleSubmit() {
    if (!eventId || !signupId || !title || !startsAt) return;
    startTransition(async () => {
      try {
        const { sessionId } = await createSessionFromSignup({
          eventId,
          signupId,
          title,
          startsAt: new Date(startsAt).toISOString(),
        });
        toast.success("Session created");
        router.push(`/sessions/${sessionId}`);
      } catch {
        toast.error("Couldn't create the session. Check EACTIVITIES_API_KEY is set.");
      }
    });
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="event">Event</Label>
          <Select value={eventId} onValueChange={handleEventChange}>
            <SelectTrigger id="event" className="w-full">
              <SelectValue placeholder="Choose a What's On event" />
            </SelectTrigger>
            <SelectContent>
              {events.map((event) => (
                <SelectItem key={event.id} value={event.id}>
                  {event.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {eventId && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="signup">Signup (attendance roster)</Label>
            <Select value={signupId} onValueChange={setSignupId} disabled={loadingSignups}>
              <SelectTrigger id="signup" className="w-full">
                <SelectValue
                  placeholder={loadingSignups ? "Loading signups…" : "Choose a signup"}
                />
              </SelectTrigger>
              <SelectContent>
                {signups?.map((signup) => (
                  <SelectItem key={signup.id} value={signup.id}>
                    {signup.title} ({signup.attendeesCount} signed up)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {signups?.length === 0 && (
              <p className="text-sm text-muted-foreground">
                This event has no signups attached.
              </p>
            )}
          </div>
        )}

        {signupId && (
          <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="title">Session title</Label>
              <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="startsAt">Starts at</Label>
              <Input
                id="startsAt"
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
              />
            </div>
            <Button onClick={handleSubmit} disabled={isPending} className="self-start">
              {isPending ? "Creating…" : "Create session"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
