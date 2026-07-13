# Repository instructions

- Communicate only in English or Ukrainian; prefer English.
- Updating from upstream must require only pulling/merging upstream changes, resolving conflicts, and rebuilding.
- Never introduce a required manual build timestamp, Git revision, expiration date, or matching `.env` value. Build creation and the 90-day expiration window must be generated automatically.
- `SOURCE_DATE_EPOCH` may remain an optional reproducible-build override, but it must never be part of the normal setup or upstream-update workflow.
