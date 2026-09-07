# RTK — tool-output compression

Coding agents shovel raw `git log`, diffs, and grep dumps into the context window. RTK
compresses those tool outputs **before the request leaves your machine**, when
`settings.rtk_on` is enabled (default: on).

Not general text compression — it targets coding-agent tool outputs specifically.

## Gates

- `MIN_COMPRESS_SIZE` = 500 chars — smaller outputs pass through untouched
- `RAW_CAP` = 10 MiB — larger outputs are skipped (something's off; don't burn CPU)
- Result is kept **only if strictly smaller** than the original

## Filters

Auto-detected from the first 1 024-char window:

| Filter | Trigger | Behavior |
|---|---|---|
| `gitLog` | full `commit <hash>` lines or ≥ 60 % oneline `<hash> <subject>` | hash + ≤ 120-char subject, ≤ 200 commits, overflow hint |
| `gitDiff` | diff headers | hunk-aware: ≤ 100 lines/hunk, ≤ 500 total, keeps `+N −M` tallies |
| `gitStatus` | status/porcelain (≥ 60 % hits over ≥ 3 lines) or `On branch` long form | groups untracked/modified/staged(+added/deleted) |
| `grep` | `file:line:content` | keeps `line: content`, groups per file, ≤ 10 shown/file with `shown/total` + recovery hint |
| `tree` | tree glyphs | ≤ 200 lines, overflow hint |
| `find` | paths | grouped by dir, ≤ 10 shown/dir, ≤ 20 dirs, honest totals + recovery hint |
| `ls` | permission columns (incl. `@`/`+`/`.` ACL markers) | dirs + files with sizes, top-5 extension histogram |
| `smartTruncate` | fallback, ≥ 250 lines | head 120 + tail 60 lines, "... +N lines truncated" |

## Accounting

`compressMessages` walks `messages[]`, compressing `role:"tool"` contents (string or text
blocks) and Claude-style `tool_result` text blocks (`is_error` blocks skipped).

Every request logs `rtk_saved` / `rtk_seen` chars — **seen counts every block that
passes the size gates, even when no filter matches** — so the dashboard's savings
ratio stays honest instead of only counting wins.

## Prompt injectors (optional companions)

Separate settings, applied at routing time before the body leaves:

- **caveman** — terse-answer system prompt, levels off/lite/full/ultra plus wenyan
  (classical Chinese) variants; rules preserve code verbatim, error strings, and language
- **ponytail** — lazy-senior-dev ladder (YAGNI, stdlib-first, shortest diff), levels
  off/lite/full/ultra

Injection appends to an existing system/developer message (string concat, or insert before a
`cache_control` block) or unshifts a new system message — including Claude-shaped
`body.system`.

Related: [ROUTING.md](ROUTING.md) · [STORAGE.md](STORAGE.md)
