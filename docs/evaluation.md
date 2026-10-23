# Retrieval evaluation runner

The evaluation runner uses the production Codex and Claude Code adapters, turn chunker, SQLite index,
keyword search, and optional local embedding model. It accepts the same JSON configuration on a laptop
or a cloud server. Evaluation never writes to original Session files.

## Configuration

All paths are absolute. A dataset entry represents one Agent and one source collection so reports stay
separable. `maxEligibleSessions` limits accepted Sessions, not files visited. Rejected files remain in
the aggregate diagnostic counts.

```json
{
  "schemaVersion": 1,
  "outputDirectory": "/data/agent-memory-eval/output",
  "datasets": [
    {
      "id": "local-codex",
      "type": "local",
      "agent": "codex",
      "roots": [
        "/home/user/.codex/sessions",
        "/home/user/.codex/archived_sessions"
      ],
      "maxEligibleSessions": 100
    },
    {
      "id": "swe-chat-claude",
      "type": "swe-chat",
      "agent": "claude-code",
      "repository": "SALT-NLP/SWE-chat",
      "revision": "0123456789abcdef0123456789abcdef01234567",
      "root": "/data/agent-memory-eval/swe-chat-claude",
      "tokenEnv": "HF_TOKEN",
      "maxSourceFiles": 500,
      "maxEligibleSessions": 400
    }
  ],
  "benchmark": {
    "modes": ["keyword", "semantic", "hybrid"],
    "embeddingCacheDirectory": "/data/agent-memory-eval/models",
    "querySplit": "test",
    "queryWarmupRuns": 1,
    "queryRuns": 3,
    "standardTools": {
      "trecEvalCommand": "trec_eval",
      "irMeasuresCommand": "ir_measures"
    }
  },
  "queryGeneration": {
    "baseUrl": "https://example.test/v1",
    "model": "configured-model",
    "apiKeyEnv": "OPENAI_API_KEY",
    "apiKeyFile": "/home/user/.config/provider/read-token",
    "datasetIds": ["swe-chat-claude"],
    "maxQueries": 200,
    "qualityReviewModel": "configured-quality-model",
    "split": {
      "groupBy": "project",
      "seed": "evaluation-v1",
      "testPercent": 20,
      "validationPercent": 20
    }
  },
  "qrelReview": {
    "baseUrl": "https://api.deepseek.com",
    "model": "deepseek-flash",
    "provider": "deepseek",
    "apiKeyEnv": "DEEPSEEK_API_KEY",
    "apiKeyFile": "/home/user/.config/deepseek/read-token",
    "datasetIds": ["swe-chat-claude"],
    "concurrency": 8,
    "relevanceThreshold": 2
  }
}
```

For a personal gated Hugging Face account, request access in the browser first and expose a read-only
token through `HF_TOKEN`. `tokenFile` may be used instead; the token is read into the request header and
is not copied into manifests or reports. SWE-chat materialization downloads `sessions.parquet` and reads
only its metadata columns in TypeScript to select canonical `Codex` or `Claude Code` rows, then downloads
raw `transcripts/` files from the same configured full commit hash. It records the original Session
timestamps and sets file mtime from Session end time, without inventing missing message timestamps.
Bounded samples are selected deterministically across the ordered turn-count and Session-time distribution,
instead of taking the first files returned by the repository.

`qrelReview` is optional. Its `datasetIds` are an explicit disclosure allow-list: only pooled chunks from
those datasets are sent to the configured endpoint. Use `apiKeyFile` or `apiKeyEnv`; the key is read at
runtime and is never copied into pools, qrels, reports, or logs. DeepSeek's OpenAI-compatible endpoint is
supported through the OpenAI Node SDK. Omit private local datasets unless sending their redacted chunks is
intentional.

## Workflow

Materialize only remote entries:

```bash
agent-memory --json eval fetch --config /data/agent-memory-eval/config.json
```

Scan explicit roots and freeze the eligible Session and chunk set:

```bash
agent-memory --json eval scan --config /data/agent-memory-eval/config.json
```

The manifest contains fingerprints, source paths, byte counts, timestamps, line ranges, native event IDs
when present, and chunk statistics. It does not contain Session body text. Local and cloud runs should exchange
this manifest when they must use the exact same sample.

Query generation, pooling, and benchmarking reject a manifest when its source fingerprints, configured
datasets, index rule, or sensitive-content rule no longer match. Re-run `eval scan` instead of mixing a stale
manifest with current source files or chunk rules.

Generate initial query and qrels candidates through the configured OpenAI-compatible endpoint. Only the
explicit `queryGeneration.datasetIds` are sent; omit local private datasets unless that disclosure is
intentional:

```bash
agent-memory --json eval generate-queries \
  --config /data/agent-memory-eval/config.json \
  --manifest /data/agent-memory-eval/output/manifest.json
```

Every generated query is reviewed in a separate model call for naturalness, clarity, answerability, and
evidence leakage. Accepted rows start with `review.status="pending"`; rejected rows remain in the JSONL for
audit but never enter pooling or benchmarks. `maxQueries` counts accepted queries. The generator assigns the
entire configured project, or the Session when project metadata is unavailable, to one deterministic
`dev`, `validation`, or `test` split. Changing any split setting requires a new candidate output file so a
held-out set cannot be silently reassigned during a resumed generation run.

Build a pooled artifact before human or LLM relevance review:

```bash
agent-memory --json eval pool \
  --config /data/agent-memory-eval/config.json \
  --manifest /data/agent-memory-eval/output/manifest.json \
  --candidates /data/agent-memory-eval/output/query-candidates.jsonl
```

The pool deduplicates the top 20 results from every configured mode, always includes the query's seed
evidence, and retains source path, JSONL line range, matching modes, native event IDs, and the complete
redacted chunk. This prevents a retrieval miss from hiding the evidence used to generate the query.

For automatic pooled qrels, run the stateless pointwise LLM reviewer:

```bash
agent-memory --json eval review-qrels \
  --config /data/agent-memory-eval/config.json \
  --candidates /data/agent-memory-eval/output/query-candidates.jsonl \
  --pool /data/agent-memory-eval/output/pool-<timestamp>/candidate-pool.json \
  --output /data/agent-memory-eval/output/llm-reviewed-qrels.jsonl
```

Each `query × chunk` call returns relevance `0` through `3`; scores at or above
`qrelReview.relevanceThreshold` become gold spans. The reviewer has no tools, history, or source-file access.
The output records configured and provider-reported model names, prompt version, threshold, per-passage
reasons, pool depth, modes, and pool generation time. A matching completed output is reused on restart.
Judgments retain the child chunk index so separately scored chunks from one long turn cannot share relevance.
`completeness="complete"` means the recorded pool was fully judged, not that the entire corpus was
exhaustively assessed.

To calibrate the LLM judgments with a first batch of 50 blind human reviews, start the separate loopback
review interface:

```bash
agent-memory eval review-ui \
  --qrels /data/agent-memory-eval/output/llm-reviewed-qrels.jsonl \
  --pool /data/agent-memory-eval/output/pool-<timestamp>/candidate-pool.json \
  --reviewer reviewer-name \
  --limit 50
```

Open the printed `http://127.0.0.1:<port>/` URL. Each case is one `query × chunk` judgment. The interface
hides the LLM score until the human selects 0 through 3, then shows whether the score was confirmed or
corrected. Progress is written atomically to `human-audit.jsonl` beside the input qrels by default. The
original silver qrels and candidate pool remain unchanged, and restarting the same command resumes the
matching audit.

For a fully human-reviewed qrels artifact, inspect the complete pool and replace each candidate's `review`
field with either:

```json
{"review":{"status":"accepted","completeness":"complete","reviewer":"name"}}
```

or:

```json
{"review":{"status":"rejected","completeness":"complete","reviewer":"name","notes":"reason"}}
```

Legacy reviewer strings remain readable. New human provenance may instead use
`{"type":"human","name":"name"}`. The review gate accepts human or LLM qrels and refuses pending
candidates or accepted candidates that are not marked complete:

```bash
agent-memory --json eval validate-qrels --qrels /data/agent-memory-eval/output/llm-reviewed-qrels.jsonl
```

Run indexing, latency, and retrieval-quality measurements only after that gate passes:

```bash
agent-memory --json eval benchmark \
  --config /data/agent-memory-eval/config.json \
  --manifest /data/agent-memory-eval/output/manifest.json \
  --qrels /data/agent-memory-eval/output/llm-reviewed-qrels.jsonl
```

## Chunk parameter ablation

Add explicit variants to the same evaluation config. The first variant is the comparison baseline; the
production Session setting is 1024 source-content tokens with 64 tokens of overlap. Keep the dataset,
query split, search modes, embedding model, and query candidates fixed across variants:

```json
"chunkAblation": {
  "variants": [
    { "id": "baseline", "maxContentTokens": 1024, "overlapContentTokens": 64 },
    { "id": "half-size", "maxContentTokens": 512, "overlapContentTokens": 64 },
    { "id": "no-overlap", "maxContentTokens": 1024, "overlapContentTokens": 0 }
  ]
}
```

Use an existing frozen manifest and generated query candidates to pool top-20 results from every mode and
variant. The pool also includes every child chunk from each query's seed turn, so changing boundaries cannot
silently remove the original evidence from review. Identical passages are reviewed once; passages that share
a turn and `chunkIndex` but differ in text keep distinct passage IDs.

```bash
agent-memory --json eval ablate-chunks pool \
  --config /data/agent-memory-eval/config.json \
  --manifest /data/agent-memory-eval/output/manifest.json \
  --candidates /data/agent-memory-eval/output/query-candidates.jsonl
```

Review the resulting `candidate-pool.json` once with the existing `eval review-qrels` command, passing it
as `--pool` and the same original candidate file as `--candidates`. This produces silver qrels keyed by
passage ID. `eval review-ui` can audit those judgments without changing them; a fully human-reviewed qrels
file may also be supplied if every pooled passage has one 0–3 judgment with its passage ID. The configured
`qrelReview.datasetIds` still controls which datasets may be sent to the LLM.

```bash
agent-memory --json eval ablate-chunks benchmark \
  --config /data/agent-memory-eval/config.json \
  --manifest /data/agent-memory-eval/output/manifest.json \
  --pool /data/agent-memory-eval/output/ablation-pool-<run>/candidate-pool.json \
  --qrels /data/agent-memory-eval/output/llm-reviewed-qrels.jsonl
```

The benchmark rejects changed source fingerprints, a changed variant list, unjudged pooled passages, and
search results absent from the reviewed pool. Every variant gets an isolated SQLite index, TREC files, and
a static Session-level HTML report. The top-level static `report.html` compares quality, query latency,
indexing time, fragment count, and SQLite size against the first variant. It records hashes of the frozen
manifest, unified pool, and selected qrels. Before projecting qrels into individual variants, the runner
freezes each accepted query's relevant turns from all passages in the judged union that meet its relevance
threshold. A turn is grouped by dataset ID, Session ID, and original start/end locations, independently of
chunk index. This grouping is evaluation-only. The fixed references are saved in `pooledTurnReferences` in
the top-level and per-variant JSON reports.

The primary comparison measures are reported at K = 5, 10, and 20:

- **Pooled Turn Recall@K:** distinct relevant turns hit in the first K results divided by the fixed number
  of relevant turns for that query. Only retrieved passages meeting the relevance threshold contribute a
  hit; irrelevant siblings from the same turn do not. A variant with no relevant passage for a pooled turn
  retains that turn in its denominator.
- **Hit@K:** 1 when at least one retrieved passage meets the relevance threshold, otherwise 0.
- **Same-turn duplicate rate@K:** repeated turn positions among the first K results divided by the number
  of results actually returned, with 0 for an empty result list. Repeats count regardless of relevance;
  lower values indicate less result-space consumption by sibling chunks.

Aggregate values are macro averages over the same accepted query set for every variant. Pooled Turn Recall
measures coverage of relevant turns found in the judged union, not exhaustive recall over the corpus. Each
variant's chunk qrels still contain only passages present in that variant. Chunk Recall and nDCG remain
auxiliary metrics whose relevant-passage sets and denominators can differ across chunk boundaries. MRR@10
measures the first relevant hit on the fixed query set. TREC cross-checks retain the original chunk metrics.

The top-level HTML report includes an expandable per-query comparison with values and percentage-point
deltas against the first variant. It shows the fixed relevant-turn locations and each variant/mode's ranked
passage IDs, child chunk indices, relevance scores, and original Session paths and locations. Per-query
metrics and rankings are also retained in each dataset's `queries` array in the JSON reports. These ranking
details omit Session body text. Source paths and relevant-turn locations link to separate offline Session
evidence pages under `sessions/`, anchored to original JSONL lines. The pages use the production adapter
to filter hidden/tool/context records and redact credentials, and record the original path and SHA-256.
Source fingerprints must still match the frozen manifest. Keep the complete benchmark directory when
copying a report so these relative links remain usable. The per-variant reports share the same evidence pages.

For an offline diagnostic rerun after changing retrieval rules, set
`benchmark.allowUnjudgedResults: true` to reuse a frozen pool and its qrels. The default remains strict:
returning a passage outside that variant's judged pool fails the ablation run. Diagnostic mode retains
such results as `unjudged` and assigns zero gain in quality metrics; it does not add or change judgments.
Reports record this setting and display a diagnostic notice. Inspect `Judged@10` in the variant reports
before interpreting quality changes, and extend the judged pool before drawing broader conclusions.

Reports include scan and indexing duration, Session and fragment counts, SQLite bytes, observed peak RSS,
query latency p50/p95/p99, Recall@5/10/20, MRR@10, and nDCG@10 for every configured search mode. Gold
locations use source Session ID plus native event IDs and original JSONL line intervals, not derived chunk
IDs, so a chunk-rule change can be evaluated against the same evidence. Manifests and reports also record
the application, index-rule, sensitive-content-rule, dataset revision, and embedding-model versions.
The report also summarizes qrels acceptance counts and reviewer types/models so auto qrels cannot be
mistaken for human judgments. Recall and MRR use binary qrels at the accepted relevance threshold; nDCG
uses the same linear 0–3 gains as `trec_eval`. Benchmarks default to the held-out `test` split. Tune on `dev`,
select a configuration on `validation`, then run `test` without inspecting its per-query outcomes. Reports
record canonical manifest and selected-split qrels SHA-256 hashes; retain those artifacts unchanged so
comparisons can verify that they used the same frozen test set.

Every benchmark exports graded and binary TREC qrels plus one run file per search mode under the run's
`trec/` directory. When `benchmark.standardTools` is configured, the runner uses `trec_eval -c` to
cross-check Recall@5/10/20, MRR@10, and nDCG@10 over the complete judged query set, including queries with
no results. A completely empty run is preserved as an empty file and verified with `ir-measures` for all
five measures; the report records `trecEval.status="skipped_empty_run"` and the successful ir-measures
comparison explicitly. This avoids invoking trec_eval on empty input, which some builds cannot read.
A missing required command or a difference greater than `0.0001` fails the benchmark.
`ir-measures` additionally calculates `Judged@10`, which indicates how
much of the top ten is covered by the judged candidate pool. Standard verification requires complete
per-document pooled judgments; legacy span-only qrels can still use native metrics but cannot claim a
passed standard cross-check. Omitting `standardTools` still writes interoperable artifacts and records
`not_configured` explicitly.

Each benchmark directory contains a self-contained `report.html` next to `report.json`. Open that file
directly in a browser; it does not require the daemon, Web management UI, or a network connection. The
report shows aggregate measures and an expandable entry for every Session in the frozen manifest. A
Session entry lists the accepted queries generated from that Session, per-mode single-query Recall, MRR,
nDCG, judged coverage, latency, and the top ranked Session IDs and source locations. Sessions without an
accepted query remain visible so test-set coverage gaps are not hidden. The report deliberately omits
Session body text while retaining query text and inspectable provenance.

Use a new empty, revision-specific SWE-chat root when changing the revision or sample size. The runner
refuses roots containing transcript files outside the requested materialization instead of deleting or
silently mixing data.

## Local reranker comparison

Add a `reranker` section to the evaluation configuration:

```json
{
  "reranker": {
    "candidateCounts": [50],
    "cacheDirectory": "/data/agent-memory-eval/models"
  }
}
```

The local cross-encoder is `onnx-community/bge-reranker-v2-m3-ONNX`, pinned to revision
`6f5ff65298512715a1e669753bc754d2bc8f367b`, with CPU q8 inference and four intra-op threads.
Each input pairs the query with the complete candidate passage. Scores are raw logits; they are not
probabilities. Input length is checked using the reranker's own tokenizer, including pair separators
and special tokens, against its 8192-token capacity. Over-capacity pairs fail instead of truncating
evidence. The first run downloads model files; subsequent runs load the pinned local cache directly.
Model provenance: [ONNX conversion](https://huggingface.co/onnx-community/bge-reranker-v2-m3-ONNX),
[original BAAI model](https://huggingface.co/BAAI/bge-reranker-v2-m3).

Freeze hybrid candidates before relevance review:

```bash
agent-memory --json eval rerank pool \
  --config /data/agent-memory-eval/config.json \
  --manifest /data/agent-memory-eval/output/manifest.json \
  --candidates /data/agent-memory-eval/output/query-candidates.jsonl
```

This command uses the production adapters, chunking, hard filters, keyword and embedding retrieval,
and RRF ranking. It selects the configured split and quality-accepted queries, and saves the raw RRF
candidate order before turn diversification. Each comparison depth uses the same candidate prefix
for baseline and reranker. The pool contains the maximum candidate prefix plus seed evidence, with
stable passage IDs derived from dataset, Session, locations, and body. `retrieval.json` records the
candidate order, provenance, measured retrieval latencies, and input hashes without passage body text.
The existing production hybrid search is also executed independently as `hybrid-current`; its Top-20
results are added to the judgment pool. This reference separates the effect of capping candidates
from the effect of the cross-encoder itself.

Review every pooled passage with the existing human or `eval review-qrels` workflow. Sending public
or private evidence to an external judge requires the user's authorization and an explicit dataset
allow-list. Model-generated judgments are silver qrels. Enlarging the candidate set requires a new
complete pool review; old Top-20 judgments do not establish relevance for new candidates.

```bash
agent-memory --json eval rerank benchmark \
  --config /data/agent-memory-eval/config.json \
  --manifest /data/agent-memory-eval/output/manifest.json \
  --pool /data/agent-memory-eval/output/rerank-pool-<id>/candidate-pool.json \
  --retrieval /data/agent-memory-eval/output/rerank-pool-<id>/retrieval.json \
  --qrels /data/agent-memory-eval/output/rerank-reviewed-qrels.jsonl
```

The runner verifies frozen inputs, full judgment coverage, passage identity, and source fingerprints.
Baseline applies turn diversification to the candidate prefix. Reranker scores the same prefix first,
then applies the same diversification. Zero-relevant queries remain in the verified input set and are
counted explicitly when excluded from quality metrics. A configured standard-tool cross-check must
pass before the run succeeds.

Each recorded inference sample executes the model. Complete per-query checkpoints can resume a run;
they retain their original timing samples and reject mismatched models or inputs. Pointwise scores
are computed at the maximum configured depth and shared by its prefixes. When comparing multiple
depths, latency is explicitly reported at that maximum depth. Total query latency combines separately
measured retrieval and reranking samples; cold model load plus synthetic warmup is recorded separately.
Keep the machine awake during timing runs. On macOS, `caffeinate -i` can scope an idle-sleep assertion
to the benchmark command. If a sample crosses an independently confirmed machine suspend, retain
the original checkpoint and power-event evidence, then remeasure that query with the same frozen
inputs. Do not subtract estimated sleep duration or discard valid slow queries.

The benchmark directory contains `report.json`, an offline `report.html`, TREC artifacts, and
provenance-only Session pages. Reports include per-query quality and rankings, pooled candidate
Recall@N, paired nDCG changes, p50/p95/p99 latency, observed process peak RSS, model identity, and
input hashes. Recall uses the judged pool's relevant passages rather than an exhaustive corpus
assessment. HTML and result JSON omit passage bodies. The shared service accepts an optional
reranker provider. Runtime searches are controlled separately by the local `rerankerEnabled` setting
and the Search-page switch; see [local reranker configuration](../README.md#local-reranker-configuration).
