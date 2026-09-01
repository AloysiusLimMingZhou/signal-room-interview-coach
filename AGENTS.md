# Project instructions

`architecture.md` is the source of truth for this repository.

Before changing system boundaries, provider behavior, persisted contracts, security controls, deployment targets, or P0 scope:

1. Read `architecture.md`.
2. Update `architecture.md` in the same change when behavior or a decision changes.
3. Keep tests and CI acceptance gates aligned with the documented architecture.

Do not expose `GEMINI_API_KEY` to browser code, logs, fixtures, screenshots, or committed files.


<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
