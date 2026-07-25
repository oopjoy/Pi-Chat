export function adjacentUserMessageOffset(offsets: number[], currentAnchor: number, direction: "previous" | "next"): number | null {
  const threshold = direction === "next" ? currentAnchor + 8 : currentAnchor - 8;
  if (direction === "next") return offsets.find((offset) => offset > threshold) ?? null;
  return [...offsets].reverse().find((offset) => offset < threshold) ?? null;
}
