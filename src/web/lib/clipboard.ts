export interface ClipboardWriter {
  writeText(text: string): Promise<void>;
}

/**
 * Keep Clipboard API capability checks and rejection semantics in one place.
 * UI callers can turn the thrown error into an explicit user-facing status;
 * this helper deliberately does not hide permission or secure-context failures.
 */
export async function writeClipboardText(
  text: string,
  clipboard: ClipboardWriter | undefined = typeof navigator !== "undefined"
    ? navigator.clipboard
    : undefined,
): Promise<void> {
  if (!clipboard || typeof clipboard.writeText !== "function")
    throw new Error("当前环境不支持剪贴板写入");
  await clipboard.writeText(text);
}
