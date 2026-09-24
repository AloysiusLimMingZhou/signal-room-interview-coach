# Signal Room v2 Phase 2 implementation plan

Date: 2026-09-24. Scope: design spec section 5, with architecture.md authoritative.

The owner authorized Phase 2 development while the Phase 1 deployment checkpoint is pending. The latest instruction also authorizes committing/pushing each completed section, opening a PR, and merging into main only after CI passes. The repository ruleset requires PRs but no separate reviewer approval for this solo project. This does not authorize deployment, cloud credentials or higher caps. Keep the implemented/automated status separate from real-session exit criteria.

## Delivery sequence and file scope

1. **Question/interviewer foundation:** content/questions/**, src/lib/questions/**, infra/lambda/shared/question-bank.ts, interviewer.ts, and their tests. Ten versioned questions (five per track), strict schemas, public projection, latest-20 exclusion/LRU selection, and four instruction snapshots. Remove the unused IdempotencyRecord export in the backend file when updating its contracts.
2. **Session and evidence v2:** src/lib/p1/contracts.ts, quota.ts, report.ts, account.ts, realtime/types.ts; infra/lambda/session-handler.ts, session-store.ts, shared/{contracts,gemini,table-keys,allowances}.ts; policy/config. Add explicit channel/track/level/language and public question; reserve channel quotas atomically; text sessions mint no token. Preserve legacy report reads and legacy session compatibility through the AWS-first rollout. Add report v2 with exact rubric competency/citation validation. No raised caps: voice 10/month and 10 min, text 60/month, 30 min, 40 turns and 4,000 candidate characters.
3. **Text turn service:** bounded schemas, infra/lambda/turn-handler.ts and supporting store/provider modules, BFF turn route and shared proxy. Own-partition checks, authoritative server context, bounded history/workspace, timeout-safe errors, idempotent replay and concurrency guard before paid generation. Conditional writes must prevent duplicate charges from concurrent retries. Keep provider output and request values out of logs.
4. **Reports, retry and deletion:** grader/account handlers and supporting helpers; authenticated BFF mutation routes. Use REPORT#v2 for new sessions, preserve v1 reads, calculate mean scores server-side, require exact rubric competencies and real evidence citations. Bound retries to two and keep lease protection. Delete only the caller's session partition plus history, with no quota refund, and prevent in-flight workers from restoring deleted data. Provide bounded evidence reads for citations after reload; the existing report API alone cannot render transcript/code citations.
5. **Lean infrastructure:** turn Lambda plus JWT routes, least-privilege item actions, stage-scoped SSM, text settings, nine prod alarm metrics, no additional emitted metric dimensions. Dev remains free of monitoring extras; synth/test only, no deployment.
6. **Adapters and lifecycle:** src/lib/realtime/**, src/lib/session/**, public/audio-worklet.js if needed. Text transport, tool responses, bounded code snapshots with matching evidence IDs/revisions, twist/time controls, one in-memory Live resume attempt, transcription timings, 16 kHz capture and filtered fallback. Provider interviewing has no canned responses or timed mock transitions.
7. **Web experience:** split interview-app into setup/room/session hook; Coding/Behavioral and five languages; allowance display; sign-in plus entirely local public demo. History and stored reports with bounded polling, citations, retry and deletion. Read bundled Next.js docs before route/page work. Add route/component/browser tests using mocks only.
8. **Final verification and documentation:** architecture/README/decision log updated per change, TDD and OWASP review, complete acceptance suite and all GHA checks on the integration PR. Record manual checks as pending until owner supplies results.

## Provider evidence and unresolved live probes

Progress: step 1 (PR #12) and step 2's session/evidence contracts (PR #13) reached main through PR #14. The text service, BFF turn route, additive BFF session contract and its step-5 Lambda/JWT/IAM/monitoring wiring are implemented in the next section. Report-v2 remains with step 4; room/adapters still use legacy contracts until their migration. Preserve compatibility throughout.

Official documentation checked 2026-09-24:

- [Ephemeral tokens](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens) documents resumption within token expiry using the same token with uses=1. Preserve uses=1 and the 12-minute maximum credential lifetime; test actual pinned-model resumption during the owner checkpoint (V1).
- [Live tools](https://ai.google.dev/gemini-api/docs/live-api/tools) lists synchronous function calling for gemini-3.1-flash-live-preview. Tool constraints and actual view_code behavior still need a real model check (V2).
- [Pinned model](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-live-preview) supports incremental client content; isolate control transport so V3 can be corrected without changing product code. Keep the specified model rather than silently migrate it.
- [Pricing](https://ai.google.dev/gemini-api/docs/pricing) lists Live text input/output at $0.75/$4.50 and audio input/output at $3/$12 per million tokens; Flash-Lite text input/output at $0.10/$0.40 per million tokens. These rates do not measure accumulated Live context or prove the budget estimates. Keep caps and first-month cost review.
- [Generate content API](https://ai.google.dev/api/generate-content) defines systemInstruction, authoritative contents and bounded generationConfig used by the text provider. The implementation keeps the specified Flash-Lite model and never enables code execution/tools.
- V4 (deployed Cognito claim shape) and V6 (actual browser audio capture) remain live checks. Mocks cannot settle them.

## Design gaps resolved explicitly during implementation

- Report citations need authenticated persisted evidence retrieval, not browser memory alone.
- The text-turn spec's transaction after the model call prevents duplicate writes but not duplicate paid calls. The implementation reserves a 30-second lease before generation, longer than the 20-second Lambda timeout, and replays the stored response afterward. Both successful turns and generation attempts are capped at 40; failures consume attempts to prevent unlimited paid retries. BFF/provider timeouts are 25/10 seconds. An ambiguous failed call is not exactly-once, but retry spend is bounded.
- Deletion must coordinate with in-flight grading/turn/event writes through a deletion tombstone/conditional ownership state, not just delete rows while workers can recreate them.
- Twists stay server-side until requested. Text control responses now return only the bounded public twist kind/prompt; voice control transport remains to be wired in the adapter slice.
- These changes must be documented and tested with the endpoint implementation, while preserving cost, ownership and validation invariants.
