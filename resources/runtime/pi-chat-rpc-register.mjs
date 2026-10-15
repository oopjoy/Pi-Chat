import * as module from "node:module";
import { loadSync } from "./pi-chat-rpc-loader.mjs";

// Both the supported system Node and bundled Node support synchronous hooks.
// Retain the original adapter as a compatibility fallback for older hosts.
if (typeof module.registerHooks === "function") {
  module.registerHooks({ load: loadSync });
} else {
  module.register("./pi-chat-rpc-loader.mjs", import.meta.url);
}
