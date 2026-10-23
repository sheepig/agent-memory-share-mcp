import { normalizeSearchText } from "./normalize.js";

export const KEYWORD_QUERY_RULE_VERSION = "or-words-han-bigrams-v1";

const hanRun = /\p{Script=Han}+/gu;
const wordRun = /[\p{L}\p{N}_-]+/gu;

export function buildSearchTerms(value: string): string {
  const normalized = normalizeSearchText(value);
  const terms = new Set<string>();

  for (const run of normalized.match(hanRun) ?? []) {
    const characters = [...run];
    for (const size of [1, 2, 3]) {
      for (let index = 0; index + size <= characters.length; index += 1) {
        terms.add(characters.slice(index, index + size).join(""));
      }
    }
  }

  const withoutHan = normalized.replace(hanRun, " ");
  for (const word of withoutHan.match(wordRun) ?? []) {
    const bounded = word.slice(0, 64);
    if (bounded.length === 1) {
      terms.add(bounded);
      continue;
    }
    for (let size = 2; size <= bounded.length; size += 1) {
      terms.add(bounded.slice(0, size));
    }
  }

  return [...terms].join(" ");
}

export function buildFtsQuery(value: string): string {
  const normalized = normalizeSearchText(value);
  const terms = new Set<string>();
  for (const run of normalized.match(hanRun) ?? []) {
    const characters = [...run];
    if (characters.length === 1) terms.add(run);
    for (let index = 0; index + 1 < characters.length; index += 1) {
      terms.add(characters.slice(index, index + 2).join(""));
    }
  }
  for (const word of normalized.replace(hanRun, " ").match(wordRun) ?? []) {
    terms.add(word.slice(0, 64));
  }
  return [...terms].map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}
