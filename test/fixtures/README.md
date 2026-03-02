# Test Fixtures — NOT in this directory

Real session `.jsonl` and `.json` files contain private conversation data and are
**never stored in the repo**. They are gitignored at this path.

Live fixture for ground-truth tests lives at:

```
c:/www/vgm9/_/AS/0.0.Q/_/test-fixtures/session-tools/e9311698-snapshot.jsonl
```

This path is outside the VS Code workspace root so the IDE search index never
touches it. Tests that require it check `FIXTURE_DIR` env var first, then fall
back to that absolute path, then skip with `SKIP: fixture not found`.

To populate locally:
```bash
cp "$APPDATA/Code - Insiders/User/workspaceStorage/<hash>/chatSessions/<uuid>.jsonl" \
   "c:/www/vgm9/_/AS/0.0.Q/_/test-fixtures/session-tools/<uuid>-snapshot.jsonl"
```

Do this BEFORE a session reboot — the file content changes on every compaction.

## Known ground-truth values (e9311698-snapshot.jsonl, captured 2026-03-02)

| Field | Value |
|---|---|
| schemaVersion | 3 |
| title | "Managing AI Agents for Nontechnical Client Projects" |
| patchCount | 6 |
| compacted request indices | 24, 35, 40, 54, 64, 78 (all in kind:0 snapshot) |
