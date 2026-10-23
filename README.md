# agent-memory-share-mcp

Local-first MCP service for searching coding-agent sessions and existing memory files.

## Development

Requires Node.js 22.12 or newer.

```bash
npm install
npm run dev
```

The web interface runs at `http://127.0.0.1:5173` during development. Use `/sessions` to manage
participating sessions and `/search` to inspect Session and Memory evidence. The local API and MCP
endpoint run at `http://127.0.0.1:43110`.

## Session and memory search

The MCP endpoint exposes `health` and three source tools:

- `list_sessions` lists Codex, Claude Code, Cursor, and OpenCode sessions accepted by the Agentic
  Stack Desktop persistent-import rules. It returns stable candidate ids and original source paths.
- `index_session` explicitly selects one listed session and writes only derived local search data.
- `search_fragments` searches selected sessions and automatically indexed distilled Markdown memory files using
  `keyword`, `semantic`, or `hybrid` mode. Every result includes its original source path and location.

The equivalent JSON endpoints for the web client are `GET /api/sessions`,
`POST /api/sessions/:candidateId/index`, `POST /api/sessions/:candidateId/exclude`,
`POST /api/sessions/:candidateId/restore`, and `GET /api/search?query=...`.

Selected sessions are indexed one complete user-to-assistant turn at a time; adjacent turns are never
combined or used to pad a short fragment. A turn whose source body exceeds 1,024 model-tokenizer tokens
is split inside that turn at Markdown, paragraph, code-block, line, sentence, and finally hard token
boundaries. Consecutive pieces from the same oversized turn overlap by 64 source-body tokens. Chunk
length excludes tokenizer-added special tokens and model wrapper text. Search results expose the chunk
index, source-body token count, original turn locations, available timestamps, and turn count. Original
session files remain read-only, and an Agent can follow the returned path and locations for more context.

Only distilled Markdown under Codex's memory directory and Claude Code project memory directories is
treated as Memory. `AGENTS.md`, `CLAUDE.md`, Cursor rules, OpenCode commands, agent definitions, and
other instruction files are not indexed as Memory.

Explicit Markdown frontmatter fields such as `title`, `project_path`, `session_id`, `date`, and `tags`
are preserved as provenance. Missing fields stay absent and are never inferred from body text.

Semantic indexing runs a pinned revision of `jinaai/jina-embeddings-v2-base-zh` locally through
Transformers.js. The quantized model is downloaded on first indexing and cached under the daemon data
directory; source text is not sent to an embedding API. Embeddings are stored as derived SQLite data.
Session display titles do not enter keyword or embedding inputs; explicit Memory titles still do.
MCP searches default to reciprocal-rank-fused `hybrid` retrieval; CLI and HTTP searches default to `keyword`.
Keyword retrieval uses OR across complete English query terms and Chinese bigrams, ranked by BM25.
English prefix and Chinese n-gram index entries remain available without expanding each query into all
short prefixes or single-character alternatives. A standalone single-character query is still supported.
For MCP, describe one information need concisely, preserving technical identifiers, negation, comparisons,
and temporal relationships. Put explicit source constraints in the separate filter parameters.
Text and keyword indexes commit independently of embedding generation. Embeddings are persisted after
each batch, reused by model and input hash, and resumed from the first missing batch after interruption.

Credential filtering covers known token formats, private keys, labelled secrets, credential URLs, and
mixed high-entropy tokens. Hashes and UUIDs are excluded from entropy detection. The security rule
version is stored with every source, so a scanner rule change queues selected evidence for rebuilding.

The daemon performs one source scan at startup and repeats it every 60 seconds by default. File and
OpenCode database discovery proceeds in bounded newest-first batches so large histories are not cut off
at a fixed file count. Per-adapter scan generations and cursors are persisted, so a daemon restart
continues an interrupted discovery before deciding that an older source disappeared. Configure
the interval with `agent-memory serve --scan-interval <seconds>`; use `0` to disable periodic scans.
`GET /api/scan/status`, `GET /api/index/status`, `POST /api/scan`, `POST /api/embeddings/retry`,
and `GET /api/diagnostics` expose worker status, index readiness, targeted semantic retry, and
compacted source diagnostics. Session listing and fragment search read only the local database and
do not trigger source scans. The daemon data directory contains a lock file that prevents a second
writer process from starting.

## Daemon and CLI

Initialize and run the background service:

```bash
agent-memory init
agent-memory daemon start
agent-memory daemon status
agent-memory doctor
```

`daemon status` returns the PID and complete MCP HTTP URL. Runtime state, the instance lock, rotating
structured logs, configuration, and SQLite data all live in the application data directory. Use
`agent-memory daemon logs`, `agent-memory daemon stop`, and `agent-memory config get|set` to manage
the process. Repeating `daemon start` returns the existing daemon status without starting a second
writer.

Configure or remove the stable MCP HTTP endpoint for a supported Agent with:

```bash
agent-memory connect codex
agent-memory connect claude-code
agent-memory connect cursor
agent-memory connect opencode
agent-memory disconnect <agent>
```

Codex and Claude Code are configured through their official MCP CLIs. Cursor and OpenCode JSON
configuration is updated atomically while preserving unrelated servers; an existing file is backed up
before replacement.

The remaining server operations are available through the local HTTP API-backed CLI:

```bash
agent-memory scan
agent-memory sessions list
agent-memory sessions index <candidateId>
agent-memory sessions exclude <candidateId>
agent-memory sessions restore <candidateId>
agent-memory search "query" --source-type session --mode hybrid
agent-memory rebuild
agent-memory diagnostics
agent-memory index status
agent-memory embeddings retry
```

`--project-path` is an exact hard filter. `--context-project-path` only boosts matching-project results
and never removes evidence from other projects.

### Local reranker configuration

The application data directory's `config.json` includes `"rerankerEnabled": false` by default. Existing
configuration files without this field keep reranking disabled. Toggle **本地重排（reranker）** on the
Search page, edit this boolean in the local file, or run:

```bash
agent-memory config set rerankerEnabled true
agent-memory config set rerankerEnabled false
```

The setting applies to subsequent Web, CLI, and MCP searches without restarting the daemon. The web
client reads and saves it through `GET` / `PATCH /api/config/search`; other daemon settings are preserved.
Each search keeps the setting it read when it started, so disabling reranking does not interrupt an
already running search.

When enabled, the pinned local BGE cross-encoder reranks up to 50 candidates (or the requested result
limit if larger) before turn diversification. Its quantized model downloads into the data directory's
`models` cache on first use; source text stays local. The first search also loads the model, and CPU
reranking can add tens of seconds per search. Disabling bypasses the model on future searches; loaded
model resources are released when the daemon closes. CLI and stdio-bridge search requests allow up to
five minutes; an MCP client may need its own request timeout adjusted.

Add the global `--json` option for stable machine-readable output. `agent-memory mcp-stdio` runs a
stdio compatibility bridge; it proxies to the daemon and never opens the SQLite database itself.

## Checks

Retrieval quality and performance use the same TypeScript runner for bounded local samples and
multi-dataset cloud runs. See [docs/evaluation.md](docs/evaluation.md) for SWE-chat materialization,
explicit source roots, eligible-Session manifests, LLM query generation, human qrels review, and benchmark
commands.

The foreground server and daemon also accept `--source-home <path>` for an isolated Agent source tree;
evaluation datasets should use the runner's explicit roots instead.

```bash
npm run typecheck
npm test
npm run build
```
