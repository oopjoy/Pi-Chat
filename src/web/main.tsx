import React from "react";
import ReactDOM from "react-dom/client";
import "./generated/katex-woff2.css";
import { App } from "./App";
import "./styles.css";

interface RootErrorBoundaryState {
  error: Error | null;
}

class RootErrorBoundary extends React.Component<React.PropsWithChildren, RootErrorBoundaryState> {
  state: RootErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RootErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error("[Pi Chat] UI rendering failed", error);
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="app-error-fallback" role="alert">
        <h1>界面暂时无法显示</h1>
        <p>当前会话数据可能包含无法渲染的内容。重新加载后会重新读取已保存的聊天记录。</p>
        <button type="button" onClick={() => window.location.reload()}>重新加载</button>
      </main>
    );
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>,
);
