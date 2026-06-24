# No test runner: verify TS logic by bundling with esbuild, then node

## What went wrong
This repo has no test framework wired into `package.json`. The IO round-trip
(`src/io/serialize.ts` <-> `parse.ts` <-> `compression.ts`) needed real runtime
verification, but the modules are TS/ESM and can't be `node`-run directly.

## Fix
esbuild ships transitively (via Vite). Write a throwaway TS harness that imports the real
source by absolute path, then bundle + run:
`./node_modules/.bin/esbuild /tmp/test.ts --bundle --platform=node --format=esm --outfile=/tmp/test.mjs && node /tmp/test.mjs`
This bundles deps (lz-string, nanoid) and exercises the actual source — no test framework
or ts-node needed. (esbuild does NOT type-check; run `npm run build` / `tsc --noEmit` for types.)

What is and isn't node-bundlable: a module that only `import type`s ExcalidrawAutomate is
fine — esbuild ERASES type-only imports, so it never pulls the excalidraw index. That is why
`src/automate/scriptRunner.ts` (and tests of `runScript`/decompile string logic) run under
node, while `ExcalidrawAutomate.ts` itself does NOT: its VALUE import of
`convertToExcalidrawElements` drags in react-dom, which throws under node even with DOM shims
(see [[ea-frames-convert-sets-frameid-auto-sizes-but-emit-children-before-the-frame]]). Rule of
thumb: pure logic + type-only excalidraw imports = node-testable; the moment you need an EA
instance or `convert`, it's browser-only.

## Verification
The harness printed PASS for all assertions (compression round-trip + 256-char chunking,
serialize/parse round-trip, deleted-element drop, curated appState, `# Text Elements`
priority over JSON).
