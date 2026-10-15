import { memo, useEffect, useMemo, useRef, useState, type ComponentProps, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import {
  encodeLocalFileImageDestination,
  encodeLocalFileMarkdownDestination,
  isLocalFileMarkdownDestination,
  LOCAL_FILE_IMAGE_FRAGMENT_PREFIX,
  LOCAL_FILE_LINK_FRAGMENT_PREFIX,
  workspaceRelativePathFromMarkdownDestination,
} from "../../shared/local-file-link";
import { createMarkdownRehypePlugins, createMarkdownRemarkPlugins } from "../lib/markdown";
import { normalizeDisplayMathForRendering, normalizeDisplayMathWithSourceMap, registerSourceCopyRoot } from "../lib/markdown-source-copy";
import {
  advanceStreamingMarkdown,
  type StreamingMarkdownAppendHint,
  type StreamingMarkdownState,
} from "../lib/streaming-markdown";
import { AlertIcon, CheckIcon, CopyIcon } from "./Icons";
import { writeClipboardText } from "../lib/clipboard";

interface MarkdownBodyProps {
  children: string;
  streaming?: boolean;
  appendHint?: StreamingMarkdownAppendHint;
  workspacePath?: string;
  onOpenLocalPath?: (path: string) => Promise<unknown>;
  /** Fetch a workspace-relative image for inline display (Session-addressed, authenticated). */
  workspaceImageFetch?: (path: string) => Promise<Blob>;
}

export function markdownLinkUrlTransform(url: string, key: string, node: Readonly<unknown>): string {
  if (key === "href" && isLocalFileMarkdownDestination(url))
    return encodeLocalFileMarkdownDestination(url);
  if (key === "src" && isLocalFileMarkdownDestination(url))
    return encodeLocalFileImageDestination(url);
  void node;
  return defaultUrlTransform(url);
}

function localDestinationFromHref(href: string | undefined): string | null {
  if (!href?.startsWith(LOCAL_FILE_LINK_FRAGMENT_PREFIX)) return null;
  try { return decodeURIComponent(href.slice(LOCAL_FILE_LINK_FRAGMENT_PREFIX.length)); }
  catch { return null; }
}

function localImageDestinationFromSrc(src: string | undefined): string | null {
  if (!src?.startsWith(LOCAL_FILE_IMAGE_FRAGMENT_PREFIX)) return null;
  try { return decodeURIComponent(src.slice(LOCAL_FILE_IMAGE_FRAGMENT_PREFIX.length)); }
  catch { return null; }
}

type MarkdownImageProps = ComponentProps<"img"> & {
  node?: unknown;
  workspacePath?: string;
  onOpenLocalPath?: (path: string) => Promise<unknown>;
  workspaceImageFetch?: (path: string) => Promise<Blob>;
};

function MarkdownImage({ node: _node, src, alt, workspacePath = "", onOpenLocalPath, workspaceImageFetch, className, title, ...props }: MarkdownImageProps) {
  const localDestination = localImageDestinationFromSrc(src);
  const relativePath = localDestination === null
    ? null
    : workspaceRelativePathFromMarkdownDestination(localDestination, workspacePath);
  const fetcher = relativePath ? workspaceImageFetch : undefined;
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    if (!fetcher || !relativePath) return;
    let cancelled = false;
    let created: string | null = null;
    setObjectUrl(null);
    setLoadError(null);
    fetcher(relativePath)
      .then((blob) => {
        if (cancelled) return;
        created = URL.createObjectURL(blob);
        setObjectUrl(created);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setLoadError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [fetcher, relativePath]);
  if (localDestination === null)
    return <img {...props} className={className} src={src} alt={alt} title={title} />;
  if (!relativePath)
    return <span className="markdown-image-fallback" title={localDestination}>🖼 {alt || localDestination}（图片不在当前会话 Workspace 内）</span>;
  if (!fetcher)
    return <span className="markdown-image-fallback" title={localDestination}>🖼 {alt || relativePath}（回复保存后可显示）</span>;
  if (loadError)
    return <span className="markdown-image-fallback" title={loadError}>🖼 {alt || relativePath}（{loadError}）</span>;
  if (!objectUrl)
    return <span className="markdown-image-fallback" title={relativePath}>🖼 {alt || relativePath}（加载中…）</span>;
  const open = onOpenLocalPath
    ? () => { void onOpenLocalPath(relativePath).catch(() => undefined); }
    : undefined;
  return <img
    {...props}
    className={`${className || ""} markdown-local-image`.trim()}
    src={objectUrl}
    alt={alt}
    title={title || `使用系统默认应用打开 ${relativePath}`}
    onClick={open}
  />;
}

type LocalLinkStatus = "idle" | "opening" | "opened" | "error";
type MarkdownLinkProps = ComponentProps<"a"> & {
  node?: unknown;
  workspacePath?: string;
  onOpenLocalPath?: (path: string) => Promise<unknown>;
};

function MarkdownLink({ children, node: _node, href, workspacePath = "", onOpenLocalPath, className, ...props }: MarkdownLinkProps) {
  const localDestination = localDestinationFromHref(href);
  const [status, setStatus] = useState<LocalLinkStatus>("idle");
  const [error, setError] = useState("");
  if (localDestination === null)
    return <a {...props} className={className} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
  const relativePath = workspaceRelativePathFromMarkdownDestination(localDestination, workspacePath);
  const open = async (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (status === "opening") return;
    if (!relativePath) {
      setStatus("error");
      setError("文件不在当前会话 Workspace 内");
      return;
    }
    if (!onOpenLocalPath) {
      setStatus("error");
      setError("当前回复尚不能打开本地文件");
      return;
    }
    setStatus("opening");
    setError("");
    try {
      await onOpenLocalPath(relativePath);
      setStatus("opened");
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const title = status === "opening"
    ? "正在打开本地文件…"
    : status === "opened"
      ? "已使用系统默认应用打开"
      : status === "error"
        ? error
        : `使用系统默认应用打开 ${relativePath || localDestination}`;
  return <>
    <a
      {...props}
      className={`${className || ""} markdown-local-file-link is-${status}`.trim()}
      href="#"
      title={title}
      aria-busy={status === "opening" ? "true" : undefined}
      onClick={(event) => void open(event)}
    >{children}</a>
    {status === "error" && <span className="markdown-link-error" role="status">{error}</span>}
    {status === "opened" && <span className="visually-hidden" role="status">已打开本地文件</span>}
  </>;
}

const baseMarkdownComponents = {
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
  table({ children: tableChildren, ...props }: { children?: ReactNode; node?: unknown }) {
    delete props.node;
    return <div className="table-scroll"><table {...props}>{tableChildren}</table></div>;
  },
};

function markdownComponentsFor(
  workspacePath: string,
  onOpenLocalPath: ((path: string) => Promise<unknown>) | undefined,
  workspaceImageFetch: ((path: string) => Promise<Blob>) | undefined,
) {
  return {
    ...baseMarkdownComponents,
    a: (props: ComponentProps<"a"> & { node?: unknown }) => <MarkdownLink {...props} workspacePath={workspacePath} onOpenLocalPath={onOpenLocalPath} />,
    img: (props: ComponentProps<"img"> & { node?: unknown }) => <MarkdownImage {...props} workspacePath={workspacePath} onOpenLocalPath={onOpenLocalPath} workspaceImageFetch={workspaceImageFetch} />,
  };
}

const streamingRehypePlugins = createMarkdownRehypePlugins();

const StreamingMarkdownSegment = memo(function StreamingMarkdownSegment({ children, workspacePath, onOpenLocalPath, workspaceImageFetch }: { children: string; workspacePath: string; onOpenLocalPath?: (path: string) => Promise<unknown>; workspaceImageFetch?: (path: string) => Promise<Blob> }) {
  const prepared = useMemo(() => normalizeDisplayMathForRendering(children), [children]);
  const remarkPlugins = useMemo(
    () => createMarkdownRemarkPlugins(prepared.tableMathPipeMarker),
    [prepared.tableMathPipeMarker],
  );
  const components = useMemo(
    () => markdownComponentsFor(workspacePath, onOpenLocalPath, workspaceImageFetch),
    [onOpenLocalPath, workspaceImageFetch, workspacePath],
  );
  return <ReactMarkdown
    remarkPlugins={remarkPlugins}
    rehypePlugins={streamingRehypePlugins}
    components={components}
    urlTransform={markdownLinkUrlTransform}
  >
    {prepared.markdown}
  </ReactMarkdown>;
});

function StreamingMarkdownBody({ children, appendHint, workspacePath, onOpenLocalPath, workspaceImageFetch }: { children: string; appendHint?: StreamingMarkdownAppendHint; workspacePath: string; onOpenLocalPath?: (path: string) => Promise<unknown>; workspaceImageFetch?: (path: string) => Promise<Blob> }) {
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
      <StreamingMarkdownSegment key={`stable-${index}`} workspacePath={workspacePath} onOpenLocalPath={onOpenLocalPath} workspaceImageFetch={workspaceImageFetch}>{segment}</StreamingMarkdownSegment>
    ))}
    {segments.tail && <StreamingMarkdownSegment key="tail" workspacePath={workspacePath} onOpenLocalPath={onOpenLocalPath} workspaceImageFetch={workspaceImageFetch}>{segments.tail}</StreamingMarkdownSegment>}
  </div>;
}

function FinalMarkdownBody({ children, workspacePath, onOpenLocalPath, workspaceImageFetch }: { children: string; workspacePath: string; onOpenLocalPath?: (path: string) => Promise<unknown>; workspaceImageFetch?: (path: string) => Promise<Blob> }) {
  const sourceMapped = useMemo(
    () => normalizeDisplayMathWithSourceMap(children),
    [children],
  );
  const remarkPlugins = useMemo(
    () => createMarkdownRemarkPlugins(sourceMapped.tableMathPipeMarker),
    [sourceMapped.tableMathPipeMarker],
  );
  const rehypePlugins = useMemo(
    () => createMarkdownRehypePlugins(sourceMapped.mapOffset),
    [sourceMapped.mapOffset],
  );
  const components = useMemo(
    () => markdownComponentsFor(workspacePath, onOpenLocalPath, workspaceImageFetch),
    [onOpenLocalPath, workspaceImageFetch, workspacePath],
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
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
        urlTransform={markdownLinkUrlTransform}
      >
        {sourceMapped.markdown}
      </ReactMarkdown>
      {sourceCopied && <span className="copy-toast" role="status">已复制 Markdown / LaTeX 源码</span>}
    </div>
  );
}

export const MarkdownBody = memo(function MarkdownBody({ children, streaming = false, appendHint, workspacePath = "", onOpenLocalPath, workspaceImageFetch }: MarkdownBodyProps) {
  return streaming
    ? <StreamingMarkdownBody appendHint={appendHint} workspacePath={workspacePath} onOpenLocalPath={onOpenLocalPath} workspaceImageFetch={workspaceImageFetch}>{children}</StreamingMarkdownBody>
    : <FinalMarkdownBody workspacePath={workspacePath} onOpenLocalPath={onOpenLocalPath} workspaceImageFetch={workspaceImageFetch}>{children}</FinalMarkdownBody>;
});

function CodeBlock({ language, children }: { language: string; children: ReactNode }) {
  const code = String(children);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const copyTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
  }, []);
  const showCopyResult = (success: boolean) => {
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    setCopied(success);
    setCopyError(!success);
    copyTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      setCopyError(false);
    }, success ? 1_200 : 2_400);
  };
  const copy = async () => {
    try {
      await writeClipboardText(code);
      showCopyResult(true);
    } catch {
      showCopyResult(false);
    }
  };
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{language}</span>
        <button type="button" onClick={() => void copy()} aria-label={copyError ? "复制代码失败" : copied ? "代码已复制" : "复制代码"} title={copyError ? "复制失败，请检查浏览器权限" : copied ? "已复制" : "复制代码"}>{copyError ? <AlertIcon /> : copied ? <CheckIcon /> : <CopyIcon />}</button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}
