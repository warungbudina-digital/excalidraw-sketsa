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

## Verification
The harness printed PASS for all assertions (compression round-trip + 256-char chunking,
serialize/parse round-trip, deleted-element drop, curated appState, `# Text Elements`
priority over JSON).
