import { useEffect, useState } from "react";

/** Error text folds only after its eleventh source line. */
export const ERROR_DETAIL_FOLD_LINE_LIMIT = 10;

export function shouldFoldErrorDetail(text: string): boolean {
  return text.split(/\r?\n/).length > ERROR_DETAIL_FOLD_LINE_LIMIT;
}

/**
 * Show the provider/Runtime body verbatim (after shared secret redaction).
 *
 * Error bodies are not Markdown: JSON, stack frames, whitespace, and delimiters
 * are diagnostic data and must remain literal. While an assistant snapshot is
 * live, its text is updated by the normal SSE delta stream and remains expanded
 * so newly arriving lines stay visible.
 */
export function ErrorDetail({ detail, streaming = false }: {
  detail: string;
  streaming?: boolean;
}) {
  const foldable = shouldFoldErrorDetail(detail);
  const [expanded, setExpanded] = useState(streaming);

  useEffect(() => {
    if (streaming) setExpanded(true);
  }, [streaming]);

  return <>
    <pre className={`message-error-detail${foldable && !expanded ? " is-collapsed" : ""}`}>{detail}</pre>
    {foldable && <button
      type="button"
      className="message-error-fold-toggle"
      aria-expanded={expanded}
      onClick={() => setExpanded((current) => !current)}
    >{expanded ? "收起" : "展开全部"}</button>}
  </>;
}
