/** Transport text contract only: this does not grant filesystem or tool authority. */
export const ATTACHED_FILES_HEADING = "[Attached files]";

export function attachedFileLines(message: string): string[] {
  let start = -1;
  for (const match of message.matchAll(/(?:^|\n)\[Attached files\]\r?\n/g)) start = match.index + match[0].length;
  if (start < 0) return [];
  return message.slice(start).split(/\r?\n/).map((line) => {
    const path = line.trim();
    return path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
  }).filter(Boolean);
}
