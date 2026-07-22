import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { createMarkdownRehypePlugins, markdownRemarkPlugins, streamingMarkdownRemarkPlugins } from "../lib/markdown";
import { normalizeDisplayMathWithSourceMap, registerSourceCopyRoot } from "../lib/markdown-source-copy";

interface MarkdownBodyProps {
  children: string;
  streaming?: boolean;
}

export const MarkdownBody = memo(function MarkdownBody({ children, streaming = false }: MarkdownBodyProps) {
  // Streaming text changes constantly. Keep that path cheap, then perform one
  // exact Markdown/KaTeX/source-map render when message_end arrives.
  const sourceMapped = useMemo(() => streaming
    ? { markdown: children, source: children, mapOffset: (offset: number) => offset }
    : normalizeDisplayMathWithSourceMap(children), [children, streaming]);
  const rehypePlugins = useMemo(() => streaming ? [] : createMarkdownRehypePlugins(sourceMapped.mapOffset), [sourceMapped, streaming]);
  const rootRef = useRef<HTMLDivElement>(null);
  const [sourceCopied, setSourceCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || streaming) return;
    return registerSourceCopyRoot(root, {
      source: sourceMapped.source,
      onCopied: () => {
        if (timerRef.current) window.clearTimeout(timerRef.current);
        setSourceCopied(true);
        timerRef.current = window.setTimeout(() => setSourceCopied(false), 1600);
      },
    });
  }, [sourceMapped.source, streaming]);

  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
  }, []);

  return (
    <div ref={rootRef} className="markdown-body markdown-source-copy">
      <ReactMarkdown
        remarkPlugins={streaming ? streamingMarkdownRemarkPlugins : markdownRemarkPlugins}
        rehypePlugins={rehypePlugins}
        components={{
          code({ className, children: codeChildren, ...props }) {
            const raw = String(codeChildren);
            const language = className?.replace("language-", "") || "text";
            const block = Boolean(className?.includes("language-") || raw.includes("\n"));
            if (block) return <CodeBlock language={language}>{raw.replace(/\n$/, "")}</CodeBlock>;
            return <code className="inline-code" {...props}>{codeChildren}</code>;
          },
          pre({ children: preChildren }) {
            return <>{preChildren}</>;
          },
          a({ children: linkChildren, ...props }) {
            delete props.node;
            return <a {...props} target="_blank" rel="noopener noreferrer">{linkChildren}</a>;
          },
          table({ children: tableChildren, ...props }) {
            delete props.node;
            return <div className="table-scroll"><table {...props}>{tableChildren}</table></div>;
          },
        }}
      >
        {sourceMapped.markdown}
      </ReactMarkdown>
      {sourceCopied && <span className="copy-toast" role="status">已复制 Markdown / LaTeX 源码</span>}
    </div>
  );
});

function CodeBlock({ language, children }: { language: string; children: ReactNode }) {
  const code = String(children);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{language}</span>
        <button type="button" onClick={copy}>{copied ? "已复制" : "复制"}</button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}
