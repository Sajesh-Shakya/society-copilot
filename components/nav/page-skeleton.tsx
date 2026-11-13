import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

export type PageSkeletonVariant = "list" | "detail" | "table" | "form"

// Default max width per variant; pages whose wrapper differs pass `maxWidth`.
const WIDTH: Record<PageSkeletonVariant, string> = {
  list: "max-w-2xl",
  detail: "max-w-3xl",
  table: "max-w-4xl",
  form: "max-w-2xl",
}

function Body({ variant }: { variant: PageSkeletonVariant }) {
  switch (variant) {
    case "list":
      return (
        <div className="space-y-3">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      )
    case "detail":
      return (
        <div className="space-y-4">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-6 w-1/3" />
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      )
    case "table":
      return (
        <div className="space-y-2">
          <Skeleton className="h-9 w-full" />
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-11 w-full" />
          ))}
        </div>
      )
    case "form":
      return (
        <div className="space-y-5">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
          <Skeleton className="h-10 w-32" />
        </div>
      )
  }
}

export function PageSkeleton({
  variant,
  maxWidth,
}: {
  variant: PageSkeletonVariant
  maxWidth?: string
}) {
  // form pages (new/import) use py-10 without the sm: step.
  const padding = variant === "form" ? "py-10" : "py-6 sm:py-10"
  return (
    <div
      role="status"
      className={cn("mx-auto px-4", maxWidth ?? WIDTH[variant], padding)}
    >
      <span className="sr-only">Loading…</span>
      <div aria-hidden="true" className="space-y-6">
        <Skeleton className="h-8 w-1/2" />
        <Body variant={variant} />
      </div>
    </div>
  )
}
