# npm install: the esbuild "allow-scripts" warning is benign here

## What went wrong
`npm install` in this repo (on this environment) prints alarming output: "9
vulnerabilities", and `npm warn allow-scripts ... esbuild@0.25.12 (postinstall: node
install.js)` "not yet covered by allowScripts". This looks like esbuild's platform binary
was blocked and the build is broken.

## Fix
Nothing to fix — it is benign. `vite build` and `vite dev` both work despite the warning
(esbuild ran fine). Do NOT run `npm audit fix --force` (pulls breaking major bumps) or
chase the allow-scripts message; it does not block the Vite/esbuild toolchain.

## Verification
`npm run build` completes with `✓ built in ~30s` and emits `dist/`; `npm run dev` serves
HTTP 200 on :8080 — both immediately after a fresh `npm install` that showed the warning.
