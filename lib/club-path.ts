export function clubPath(clubSlug: string, path: string): string {
  return `/club/${clubSlug}${path.startsWith("/") ? path : `/${path}`}`;
}
