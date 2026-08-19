import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { createMarkdownRehypePlugins, markdownRemarkPlugins } from "../lib/markdown";
import { normalizeDisplayMathWithSourceMap, registerSourceCopyRoot } from "../lib/markdown-source-copy";
import { streamingMarkdownBlocks } from "../lib/streaming-markdown";
import { CheckIcon, CopyIcon } from "./Icons";

interface MarkdownBodyProps {
  children: string;
  streaming?: boolean;
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

function streamingInlineText(text: string): ReactNode {
  const pieces: ReactNode[] = [];
  const pattern = /(?<!\\)\*\*([^*\r\n]+?)\*\*/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > cursor) pieces.push(text.slice(cursor, match.index));
    pieces.push(<strong key={match.index}>{match[1]}</strong>);
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) pieces.push(text.slice(cursor));
  return pieces.length ? pieces : text;
}

function StreamingMarkdownBody({ children }: { children: string }) {
  const blocks = useMemo(() => streamingMarkdownBlocks(children), [children]);
  return <div className="markdown-body markdown-streaming">
    {blocks.map((block, index) => {
      if (block.kind === "heading") {
        const Heading = `h${block.level}` as "h1" | "h2" | "h3" | "h4";
        return <Heading key={index}>{streamingInlineText(block.text)}</Heading>;
      }
      if (block.kind === "list") {
        const List = block.ordered ? "ol" : "ul";
        return <List key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{streamingInlineText(item)}</li>)}</List>;
      }
      if (block.kind === "quote") return <blockquote key={index}>{streamingInlineText(block.text)}</blockquote>;
      if (block.kind === "code") return <CodeBlock key={index} language={block.language}>{block.text}</CodeBlock>;
      return <p key={index}>{block.text.split("\n").map((line, lineIndex) => <Fragment key={lineIndex}>{lineIndex > 0 && <br />}{streamingInlineText(line)}</Fragment>)}</p>;
    })}
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

export const MarkdownBody = memo(function MarkdownBody({ children, streaming = false }: MarkdownBodyProps) {
  return streaming
    ? <StreamingMarkdownBody>{children}</StreamingMarkdownBody>
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
