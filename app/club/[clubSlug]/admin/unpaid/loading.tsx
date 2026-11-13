import { PageSkeleton } from "@/components/nav/page-skeleton"

export default function Loading() {
  // The unpaid page wrapper is max-w-3xl, narrower than the table default.
  return <PageSkeleton variant="table" maxWidth="max-w-3xl" />
}
