# CLAUDE.md

Guidance for working in this repository.

## Project

**Zero Edit Time** — a browser-based, AI-assisted video editor that runs entirely client-side.
It is being built in **phases**. Build only the current phase; do not scaffold, stub, or create
empty folders for future phases.

- **Phase 0 (current):** prove "file-in → plays". Pick a local video, play it, show its duration.
- **Later phases (do NOT build yet):** non-destructive EDL editing model, transcription, an AI
  agent, and `ffmpeg.wasm` export.

## Stack

- React 19 + TypeScript, bundled with Vite 8.
- Package manager: **pnpm only** — never `npm` or `yarn`.
- No UI or styling libraries. Plain React + the Vite template.

## Commands

```bash
pnpm dev      # start the Vite dev server
pnpm build    # tsc -b && vite build — typecheck + production build
pnpm lint     # eslint
pnpm preview  # serve the production build locally
```

Run `pnpm build` to confirm changes typecheck and compile.

## Constraints

- **Strict TypeScript, no `any`.** Type DOM/React event handlers explicitly.
- **No new dependencies** unless a phase genuinely requires it.
- Keep app code in `src/App.tsx`; add a component only if it genuinely helps.
- Do not re-init the project or overwrite toolchain config (`vite.config.ts`, `tsconfig*.json`,
  `eslint.config.js`).

## Layout

- `src/App.tsx` — the app. Phase 0 = file picker → object URL → `<video controls>` → duration
  from the `loadedmetadata` event. Object URLs are revoked on replace/unmount to avoid leaks.
- `src/main.tsx` — React entry (`StrictMode`).
- `src/index.css` — Vite template styles (`#root` is a centered 1126px column).
- `public/_headers` — sets COOP `same-origin` + COEP `require-corp`. **Do not remove.** These
  enable cross-origin isolation / `SharedArrayBuffer`, which `ffmpeg.wasm` export needs later.
  Vite copies `public/` verbatim into `dist/`.
