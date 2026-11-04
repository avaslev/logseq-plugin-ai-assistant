import reactPlugin from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import logseqDevPluginCjs from "vite-plugin-logseq";

const logseqDevPlugin =
  (logseqDevPluginCjs as unknown as { default?: typeof logseqDevPluginCjs })
    .default ?? logseqDevPluginCjs;

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [logseqDevPlugin(), reactPlugin()],
  // Makes HMR available for development
  build: {
    target: "esnext",
  },
});
