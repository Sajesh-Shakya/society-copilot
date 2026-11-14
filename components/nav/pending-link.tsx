"use client";

import * as React from "react";
import Link, { useLinkStatus } from "next/link";
import { Loader2Icon } from "lucide-react";
import { cn } from "@/lib/utils";

// useLinkStatus only works in a descendant of <Link>, hence the inner component.
// The spinner is rendered only while pending, so idle links look unchanged.
function Spinner({ className }: { className?: string }) {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return <Loader2Icon aria-hidden data-testid="link-pending" className={cn("size-3.5 shrink-0 animate-spin", className)} />;
}

type LinkProps = React.ComponentProps<typeof Link>;

type PendingLinkProps = Omit<LinkProps, "prefetch"> & {
  prefetch?: boolean | null;
  spinnerClassName?: string;
};

// Forwards every anchor prop (className, data-*, onClick, ...) to Link so it
// composes with `<Button asChild>` (Radix Slot merges props onto this element).
export function PendingLink({ children, prefetch, spinnerClassName, ...props }: PendingLinkProps) {
  return (
    <Link prefetch={prefetch as LinkProps["prefetch"]} {...props}>
      {children}
      <Spinner className={spinnerClassName} />
    </Link>
  );
}
