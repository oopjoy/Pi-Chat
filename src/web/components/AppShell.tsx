import type { CSSProperties, ReactNode } from "react";

/** Render-only application frame; lifecycle state remains coordinator-owned. */
export function AppShell({ diffSidebarOpen, diffSidebarWidth, children }: {
  diffSidebarOpen: boolean;
  diffSidebarWidth: number;
  children: ReactNode;
}) {
  return <div
    className="app-shell"
    style={{
      "--diff-sidebar-width": diffSidebarOpen
        ? `${diffSidebarWidth}px`
        : "0px",
    } as CSSProperties}
  >
    {children}
  </div>;
}
