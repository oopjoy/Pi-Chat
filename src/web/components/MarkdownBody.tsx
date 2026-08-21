import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { createMarkdownRehypePlugins, markdownRemarkPlugins } from "../lib/markdown";
import { normalizeDisplayMathWithSourceMap, registerSourceCopyRoot } from "../lib/markdown-source-copy";
import {
  advanceStreamingMarkdown,
  type StreamingMarkdownAppendHint,
  type StreamingMarkdownState,
} from "../lib/streaming-markdown";
import { CheckIcon, CopyIcon } from "./Icons";

interface MarkdownBodyProps {
  children: string;
  streaming?: boolean;
  appendHint?: StreamingMarkdownAppendHint;
}

const markdownComponents = {
  code({ className, children: codeChildren, ...props }: { className?: string; children?: ReactNode }) {
    const raw = String(codeChildren);
    const language = className?.replace("language-", "") || "text";
    const block = Boolean(className?.includes("language-") || raw.includes("\n"));
    if (block) return <CodeBlock language={language}>{raw.replace(/\n$/, "")}</CodeBlock>;
    return <code className="inline-code" {...props}>{codeChildren}</code>;
  },
  pre({ children: preChildren }: { children?: ReactNode }) {
    return <>{preChildren}</>;
  },
  a({ children: linkChildren, ...props }: { children?: ReactNode; node?: unknown }) {
    delete props.node;
    return <a {...props} target="_blank" rel="noopener noreferrer">{linkChildren}</a>;
  },
  table({ children: tableChildren, ...props }: { children?: ReactNode; node?: unknown }) {
    delete props.node;
    return <div className="table-scroll"><table {...props}>{tableChildren}</table></div>;
  },
};

const streamingRehypePlugins = createMarkdownRehypePlugins();

const StreamingMarkdownSegment = memo(function StreamingMarkdownSegment({ children }: { children: string }) {
  return <ReactMarkdown
    remarkPlugins={markdownRemarkPlugins}
    rehypePlugins={streamingRehypePlugins}
    components={markdownComponents}
  >
    {children}
  </ReactMarkdown>;
});

function StreamingMarkdownBody({ children, appendHint }: { children: string; appendHint?: StreamingMarkdownAppendHint }) {
  const stateRef = useRef<StreamingMarkdownState | undefined>(undefined);
  const segments = useMemo(() => {
    // Concurrent React may abandon a render after this ref advances. A later
    // non-prefix source deliberately triggers advanceStreamingMarkdown's full
    // reset, so render-phase speculation can cost a rescan but not correctness.
    const advanced = advanceStreamingMarkdown(stateRef.current, children, appendHint);
    stateRef.current = advanced;
    return advanced;
  }, [appendHint, children]);
  return <div className="markdown-body markdown-streaming">
    {segments.stable.map((segment, index) => (
      <StreamingMarkdownSegment key={`stable-${index}`}>{segment}</StreamingMarkdownSegment>
    ))}
    {segments.tail && <StreamingMarkdownSegment key="tail">{segments.tail}</StreamingMarkdownSegment>}
  </div>;
}

function FinalMarkdownBody({ children }: { children: string }) {
  const sourceMapped = useMemo(
    () => normalizeDisplayMathWithSourceMap(children),
    [children],
  );
  const rehypePlugins = useMemo(
    () => createMarkdownRehypePlugins(sourceMapped.mapOffset),
    [sourceMapped.mapOffset],
  );
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
        components={markdownComponents}
      >
        {sourceMapped.markdown}
      </ReactMarkdown>
      {sourceCopied && <span className="copy-toast" role="status">已复制 Markdown / LaTeX 源码</span>}
    </div>
  );
}

export const MarkdownBody = memo(function MarkdownBody({ children, streaming = false, appendHint }: MarkdownBodyProps) {
  return streaming
    ? <StreamingMarkdownBody appendHint={appendHint}>{children}</StreamingMarkdownBody>
    : <FinalMarkdownBody>{children}</FinalMarkdownBody>;
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
        <button type="button" onClick={copy} aria-label={copied ? "代码已复制" : "复制代码"} title={copied ? "已复制" : "复制代码"}>{copied ? <CheckIcon /> : <CopyIcon />}</button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}
