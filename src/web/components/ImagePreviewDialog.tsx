import { useEffect, useRef, type CSSProperties } from "react";
import { createPortal } from "react-dom";

export function ImagePreviewDialog({
  src,
  alt,
  label,
  width,
  height,
  onClose,
}: {
  src: string;
  alt: string;
  label: string;
  width?: number;
  height?: number;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        closeRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [src]);

  const dialogStyle = width && height
    ? { maxWidth: `${Math.max(0, width - 48)}px`, maxHeight: `${Math.max(0, height - 48)}px` } as CSSProperties
    : undefined;
  const imageStyle = width && height
    ? { maxWidth: `${Math.max(0, width - 74)}px`, maxHeight: `${Math.max(0, height - 102)}px` } as CSSProperties
    : undefined;

  return createPortal(
    <div
      className="image-preview-backdrop"
      role="presentation"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section
        className="image-preview-dialog"
        style={dialogStyle}
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        <button
          ref={closeRef}
          type="button"
          className="image-preview-close"
          onClick={onClose}
          aria-label="关闭图片预览"
          title="关闭图片预览"
        >关闭</button>
        <img className="image-preview-full" style={imageStyle} src={src} alt={alt} />
      </section>
    </div>,
    document.body,
  );
}
