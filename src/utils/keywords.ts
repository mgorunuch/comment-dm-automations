const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * True when `text` contains one of `keywords` as a whole word (or phrase), ignoring case.
 * "Pricing?" and "what's the PRICING" match "pricing"; "pricings" and "repricing" do not.
 */
export function containsKeyword(text: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) =>
    new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(keyword.trim())}(?![\\p{L}\\p{N}])`, "iu").test(text),
  );
}
