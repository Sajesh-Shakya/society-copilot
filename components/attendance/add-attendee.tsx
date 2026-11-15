"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  searchPeople,
  addExistingPersonToSession,
  createWalkIn,
  type PersonSearchResult,
} from "@/lib/attendance/actions";
import type { AttendanceRow } from "@/lib/attendance/queries";
import { validateWalkInFields } from "@/lib/identity/walk-in-schema";

// AC-4 then AC-5, chained: search for an existing person by (possibly
// misspelled) name first; only if none of the suggestions match does the
// walk-in form (a brand new person) appear. Never auto-merges a fuzzy match
// — the admin always picks explicitly.
export function AddAttendee({
  sessionId,
  clubSlug,
  existingPersonIds,
  onAdded,
}: {
  sessionId: string;
  clubSlug: string;
  existingPersonIds: string[];
  onAdded: (row: AttendanceRow) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PersonSearchResult[] | null>(null);
  const [showWalkIn, setShowWalkIn] = useState(false);
  const [walkInEmail, setWalkInEmail] = useState("");
  const [walkInName, setWalkInName] = useState("");
  const [walkInCid, setWalkInCid] = useState("");
  const [isPending, startTransition] = useTransition();

  // Same schema the server action parses with, so the messages match. Name
  // and CID errors show as soon as something is typed; email's only once it
  // is non-empty (the browser's type="email" covers the rest).
  const fieldErrors = validateWalkInFields({ email: walkInEmail, fullName: walkInName, cid: walkInCid });
  const walkInInvalid = !walkInEmail || !walkInName || Object.keys(fieldErrors).length > 0;
  const nameError = walkInName ? fieldErrors.fullName : undefined;
  const emailError = walkInEmail ? fieldErrors.email : undefined;
  const cidError = walkInCid ? fieldErrors.cid : undefined;

  function reset() {
    setOpen(false);
    setQuery("");
    setResults(null);
    setShowWalkIn(false);
    setWalkInEmail("");
    setWalkInName("");
    setWalkInCid("");
  }

  function handleSearch(value: string) {
    setQuery(value);
    if (value.trim().length < 2) {
      setResults(null);
      return;
    }
    startTransition(async () => {
      try {
        const found = await searchPeople(clubSlug, value);
        // Show every match, including people already on this session's
        // list -- silently filtering them out (the old behavior) made a
        // duplicate-add attempt look identical to "no matches", which
        // could push an admin into creating a genuine duplicate person via
        // the walk-in form below instead.
        setResults(found);
      } catch {
        toast.error("Search failed");
      }
    });
  }

  function handleAddExisting(person: PersonSearchResult) {
    startTransition(async () => {
      try {
        await addExistingPersonToSession(clubSlug, sessionId, person.id);
        onAdded({
          attendanceRecordId: crypto.randomUUID(),
          personId: person.id,
          fullName: person.fullName,
          email: person.email,
          attended: true,
          source: "manual_tick",
        });
        toast.success(`Added ${person.fullName}`);
        reset();
      } catch {
        toast.error("Couldn't add that person");
      }
    });
  }

  function handleCreateWalkIn() {
    if (walkInInvalid) return;
    startTransition(async () => {
      try {
        const result = await createWalkIn(clubSlug, {
          sessionId,
          email: walkInEmail,
          fullName: walkInName,
          cid: walkInCid || undefined,
        });
        if ("error" in result) {
          // The server is the authority; its validation message is readable.
          toast.error(`Couldn't add walk-in — ${result.error}`);
          return;
        }
        const { personId, reusedExisting } = result;
        const displayName = walkInName.trim().replace(/\s+/g, " ");
        onAdded({
          attendanceRecordId: crypto.randomUUID(),
          personId,
          fullName: displayName,
          email: walkInEmail,
          attended: true,
          source: reusedExisting ? "manual_tick" : "walk_in",
        });
        toast.success(
          reusedExisting
            ? `${displayName} already existed with that email or CID — added to this session instead of creating a duplicate`
            : `Added ${displayName} as a walk-in`
        );
        reset();
      } catch {
        toast.error("Couldn't add walk-in — please try again");
      }
    });
  }

  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)} className="self-start">
        Add someone not on the list
      </Button>
    );
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="search">Search by name</Label>
          <Input
            id="search"
            value={query}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="Start typing a name…"
            autoFocus
          />
        </div>

        {results && results.length > 0 && (
          <ul className="flex flex-col gap-1">
            {results.map((person) => {
              const alreadyAdded = existingPersonIds.includes(person.id);
              return (
                <li key={person.id} className="flex items-center justify-between gap-2 py-1">
                  <div>
                    <div className="text-sm">{person.fullName}</div>
                    <div className="text-xs text-muted-foreground">{person.email}</div>
                  </div>
                  {alreadyAdded ? (
                    <Badge variant="secondary">Already on this list</Badge>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => handleAddExisting(person)} disabled={isPending}>
                      Add
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {results && results.length === 0 && !showWalkIn && (
          <p className="text-sm text-muted-foreground">No matches.</p>
        )}

        {!showWalkIn ? (
          <Button variant="ghost" onClick={() => setShowWalkIn(true)} className="self-start">
            None of these — create new person
          </Button>
        ) : (
          <div className="flex flex-col gap-3 border-t pt-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="walkin-name">Full name</Label>
              <Input
                id="walkin-name"
                value={walkInName}
                onChange={(e) => setWalkInName(e.target.value)}
                aria-invalid={!!nameError}
                aria-describedby={nameError ? "walkin-name-error" : undefined}
              />
              {nameError && (
                <p id="walkin-name-error" className="text-sm text-destructive">
                  {nameError}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="walkin-email">Email (required)</Label>
              <Input
                id="walkin-email"
                type="email"
                value={walkInEmail}
                onChange={(e) => setWalkInEmail(e.target.value)}
                aria-invalid={!!emailError}
                aria-describedby={emailError ? "walkin-email-error" : undefined}
              />
              {emailError && (
                <p id="walkin-email-error" className="text-sm text-destructive">
                  {emailError}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="walkin-cid">CID (optional — external/non-member guests won&apos;t have one)</Label>
              <Input
                id="walkin-cid"
                value={walkInCid}
                onChange={(e) => setWalkInCid(e.target.value)}
                inputMode="numeric"
                aria-invalid={!!cidError}
                aria-describedby={cidError ? "walkin-cid-error" : undefined}
              />
              {cidError && (
                <p id="walkin-cid-error" className="text-sm text-destructive">
                  {cidError}
                </p>
              )}
            </div>
            <Button onClick={handleCreateWalkIn} disabled={isPending || walkInInvalid} className="self-start">
              Add walk-in
            </Button>
          </div>
        )}

        <Button variant="ghost" size="sm" onClick={reset} className="self-start text-muted-foreground">
          Cancel
        </Button>
      </CardContent>
    </Card>
  );
}
