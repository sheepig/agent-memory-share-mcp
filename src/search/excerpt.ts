const EXCERPT_LENGTH = 500;

function firstMatch(body: string, query: string): number {
  const normalizedBody = body.toLocaleLowerCase();
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const exact = normalizedBody.indexOf(normalizedQuery);
  if (exact >= 0) return exact;
  for (const term of normalizedQuery.split(/\s+/u).filter((value) => value.length >= 2)) {
    const index = normalizedBody.indexOf(term);
    if (index >= 0) return index;
  }
  return 0;
}

export function buildSearchExcerpt(body: string, query: string): string {
  if (body.length <= EXCERPT_LENGTH) return body;
  const match = firstMatch(body, query);
  const start = Math.max(0, Math.min(body.length - EXCERPT_LENGTH, match - Math.floor(EXCERPT_LENGTH / 3)));
  const excerpt = body.slice(start, start + EXCERPT_LENGTH);
  return `${start > 0 ? "…" : ""}${excerpt}${start + EXCERPT_LENGTH < body.length ? "…" : ""}`;
}
