"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { searchPeople } from "@/lib/attendance/actions";
import { matchPurchaseToPersonAction, suggestPersonsAction } from "@/lib/identity/actions";
import type { CidEffect } from "@/lib/identity/suggestions";
import { normalizeCid } from "@/lib/utils";

interface Candidate {
  personId: string;
  fullName: string;
  email: string;
  cid: string | null;
  cidSource: string | null;
  /** Unknown for search results (the search RPC doesn't return cid_source). */
  cidEffect: CidEffect | null;
}

const EFFECT_LABEL: Record<CidEffect, string> = {
  set: "CID would fill a blank",
  overwrite: "CID would overwrite theirs",
  flag: "CID would be flagged",
  ignore: "CID would be ignored (theirs is better-sourced)",
  confirm: "Same CID",
  none: "",
};

/** Default for "Use this purchase's CID": on only when the CID would actually be written. */
function defaultAdopt(candidate: Candidate, purchaseCid: string | null): boolean {
  if (!purchaseCid) return false;
  if (candidate.cidEffect) return candidate.cidEffect === "set" || candidate.cidEffect === "overwrite";
  return candidate.cid === null;
}

/**
 * Inline panel for hand-matching one unmatched purchase: suggested people
 * (email / unique-name matches), a name search, an optional "use this
 * purchase's CID" checkbox, and a confirm button.
 */
export function MatchPanel({
  clubSlug,
  purchase,
  onMatched,
  onCancel,
}: {
  clubSlug: string;
  purchase: { id: string; rawPersonName: string; rawCid: string | null };
  onMatched: () => void;
  onCancel: () => void;
}) {
  const purchaseCid = purchase.rawCid?.trim() ? normalizeCid(purchase.rawCid) : null;
  const [suggestions, setSuggestions] = useState<Candidate[] | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Candidate[] | null>(null);
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [adoptCid, setAdoptCid] = useState(false);
  const [isSearching, startSearch] = useTransition();
  const [isMatching, startMatch] = useTransition();

  useEffect(() => {
    let cancelled = false;
    suggestPersonsAction(clubSlug, purchase.id)
      .then((result) => {
        if (cancelled) return;
        if ("error" in result) {
          toast.error(result.error);
          setSuggestions([]);
        } else {
          setSuggestions(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          toast.error("Couldn't load suggestions");
          setSuggestions([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [clubSlug, purchase.id]);

  function select(candidate: Candidate) {
    setSelected(candidate);
    setAdoptCid(defaultAdopt(candidate, purchaseCid));
  }

  function handleSearch(value: string) {
    setQuery(value);
    if (value.trim().length < 2) {
      setResults(null);
      return;
    }
    startSearch(async () => {
      try {
        const found = await searchPeople(clubSlug, value);
        setResults(
          found.map((p) => ({
            personId: p.id,
            fullName: p.fullName,
            email: p.email,
            cid: p.cid,
            cidSource: null,
            cidEffect: null,
          }))
        );
      } catch {
        toast.error("Search failed");
      }
    });
  }

  function handleConfirm() {
    if (!selected) return;
    const person = selected;
    startMatch(async () => {
      try {
        const result = await matchPurchaseToPersonAction(clubSlug, purchase.id, person.personId, {
          adoptCid: adoptCid && purchaseCid !== null,
        });
        if ("error" in result) {
          toast.error(`Couldn't match — ${result.error}`);
          return;
        }
        const decision = result.cid.decision;
        if (decision === "flag" || decision === "ignore") {
          toast.success(
            `Matched to ${person.fullName}. Their CID was kept; the CID conflict was recorded for review.`
          );
        } else if (decision === "set" || decision === "overwrite") {
          toast.success(`Matched to ${person.fullName} and saved the purchase's CID.`);
        } else {
          toast.success(`Matched to ${person.fullName}.`);
        }
        onMatched();
      } catch {
        toast.error("Match failed unexpectedly.");
      }
    });
  }

  function renderList(list: Candidate[]) {
    return (
      <ul className="flex flex-col gap-1">
        {list.map((c) => {
          const isSelected = selected?.personId === c.personId;
          return (
            <li key={c.personId} className="flex items-center justify-between gap-2 py-1">
              <div className="min-w-0">
                <div className="text-sm">{c.fullName}</div>
                <div className="text-xs text-muted-foreground">
                  {c.email}
                  {" · CID "}
                  {c.cid ?? "none"}
                  {c.cidSource ? ` (${c.cidSource})` : ""}
                </div>
                {c.cidEffect && EFFECT_LABEL[c.cidEffect] && (
                  <div className="text-xs text-muted-foreground">{EFFECT_LABEL[c.cidEffect]}</div>
                )}
              </div>
              {isSelected ? (
                <Badge variant="secondary">Selected</Badge>
              ) : (
                <Button size="sm" variant="secondary" onClick={() => select(c)} disabled={isMatching}>
                  Select
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  const searchInputId = `match-search-${purchase.id}`;
  const adoptId = `match-adopt-${purchase.id}`;

  return (
    <div className="flex flex-col gap-4 p-3">
      <div className="text-sm">
        Match <span className="font-medium">{purchase.rawPersonName}</span>
        {purchaseCid ? ` (CID ${purchaseCid})` : ""} to a person
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs font-medium text-muted-foreground">Suggestions</div>
        {suggestions === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : suggestions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No email or unique-name match.</p>
        ) : (
          renderList(suggestions)
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={searchInputId}>Search by name</Label>
        <Input
          id={searchInputId}
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder="Start typing a name…"
        />
        {isSearching && <p className="text-xs text-muted-foreground">Searching…</p>}
        {results && results.length > 0 && renderList(results)}
        {results && results.length === 0 && <p className="text-sm text-muted-foreground">No matches.</p>}
      </div>

      <div className="flex items-center gap-2">
        <Checkbox
          id={adoptId}
          checked={adoptCid && purchaseCid !== null}
          disabled={purchaseCid === null || isMatching}
          onCheckedChange={(v) => setAdoptCid(v === true)}
        />
        <Label htmlFor={adoptId} className={purchaseCid === null ? "text-muted-foreground" : undefined}>
          Use this purchase&apos;s CID for them
        </Label>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleConfirm} disabled={!selected || isMatching}>
          {isMatching ? "Matching…" : selected ? `Match to ${selected.fullName}` : "Select a person"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={isMatching}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
