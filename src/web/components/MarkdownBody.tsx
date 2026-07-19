import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { createMarkdownRehypePlugins, markdownRemarkPlugins } from "../lib/markdown";
import { normalizeDisplayMathWithSourceMap, registerSourceCopyRoot } from "../lib/markdown-source-copy";

interface MarkdownBodyProps {
  children: string;
  streaming?: boolean;
}

export const MarkdownBody = memo(function MarkdownBody({ children }: MarkdownBodyProps) {
  const sourceMapped = useMemo(() => normalizeDisplayMathWithSourceMap(children), [children]);
  const rehypePlugins = useMemo(() => createMarkdownRehypePlugins(sourceMapped.mapOffset), [sourceMapped]);
  const rootRef = useRef<HTMLDivElement>(null);
  const [sourceCopied, setSourceCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    return registerSourceCopyRoot(root, {
      source: sourceMapped.source,
      onCopied: () => {
        if (timerRef.current) window.clearTimeout(timerRef.current);
        setSourceCopied(true);
        timerRef.current = window.setTimeout(() => setSourceCopied(false), 1600);
      },
    });
  }, [sourceMapped.source]);

  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
  }, []);

  return (
    <div ref={rootRef} className="markdown-body markdown-source-copy">
      <ReactMarkdown
        remarkPlugins={markdownRemarkPlugins}
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
