import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const reactRenderBenchmarkEnabled = process.env.PI_CHAT_BENCHMARK_REACT_PROFILER === "1";

export default defineConfig({
  plugins: [react()],
  root: "src/web",
  resolve: {
    alias: reactRenderBenchmarkEnabled
      ? [{ find: "react-dom/client", replacement: "react-dom/profiling" }]
      : [],
  },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "react", test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/ },
            { name: "markdown", test: /node_modules[\\/](?:react-markdown|remark-|rehype-|unified|unist-|micromark|mdast-|hast-|property-information|vfile|decode-named-character-reference|character-entities|comma-separated-tokens|space-separated-tokens|trim-lines|devlop)[\\/]/ },
            { name: "katex", test: /node_modules[\\/]katex[\\/]/ },
          ],
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
});
