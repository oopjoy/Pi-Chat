export function adjacentUserMessageOffset(offsets: number[], scrollTop: number, direction: "previous" | "next"): number | null {
  const threshold = direction === "next" ? scrollTop + 8 : scrollTop - 8;
  if (direction === "next") return offsets.find((offset) => offset > threshold) ?? null;
  return [...offsets].reverse().find((offset) => offset < threshold) ?? null;
}
