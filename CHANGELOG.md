# Changelog

## Unreleased

### Added

- Answer each `session/prompt` with the turn's token usage (`PromptResponse.usage`), counted from the `usage` Amp reports on each model response. A response streamed as several messages that share an id is counted once. ACP marks the field experimental, and clients that do not read it are unaffected.
- Advertise and implement ACP session listing from the durable mapping store: normalized cwd filtering, descending activity timestamps, 50-item cursor pagination, corrupt-record skipping and legacy mtime fallback. Titles remain absent; no prompt content is persisted.

### Fixed

- Deliver prompt images to the local CLI as ordered JSONL content instead of silently discarding them. Validate base64, supported MIME types and magic bytes before execution; reject unsupported Orb/SDK image turns explicitly. Keep text-only input unchanged.
- Advertise standard terminal authentication only to clients that enable it. Keep validated legacy setup metadata, run JS/npx scripts through their interpreter, and omit nonexistent or virtual Bun commands instead of advertising a broken setup path. Require confirmed standalone mode for a scriptless executable fallback; never advertise a bare Node/Bun runtime or directory as the setup launcher.
- Persist session activity at successful turn completion and refresh connection MCP configuration on `session/load`, including already-loaded sessions. Preserve exact-thread load/resume and best-effort protocol history replay.

## 0.10.0 - 2026-08-27

### Added

- Persist the exact ACP `S-...` session to Amp `T-...` thread mapping so `session/resume` continues the same thread after an amp-acp restart.
- Advertise lifecycle protocol v1 in ACP capability metadata and expose custom native-metadata and archive/unarchive methods.
- Store mappings atomically in owner-only state storage without prompts, responses, credentials, or Amp settings.

### Compatibility and migration

- Existing ACP clients can ignore the extension and continue using standard session and prompt methods.
- Sessions created before 0.10.0 do not have a durable mapping and therefore cannot use restart resume or lifecycle archival. A new session records its mapping on the first successful Amp thread initialization.
- Missing or mismatched mappings fail safely. amp-acp never infers lifecycle ownership from the latest thread, working directory, title, timestamp, or thread listing because those signals can select another CLI, editor, or concurrent session's thread.

### Verification

- Add protocol, persistence, restart-resume, archive/unarchive validation, CLI argument, security, and legacy-session coverage.
- Keep compiled-binary ACP client coverage aligned with real durable Amp thread ID syntax.
