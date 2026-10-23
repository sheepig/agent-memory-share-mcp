import { useQuery } from "@tanstack/react-query";
import { FileSearch, LibraryBig, Search } from "lucide-react";
import { type FormEvent, useState } from "react";

import { EmptyState } from "../components/empty-state.js";
import { RerankerSettings } from "../components/reranker-settings.js";
import { ServiceStatus } from "../components/service-status.js";
import { searchFragments, type Agent } from "../lib/api.js";

interface SearchParameters {
  agent?: Agent;
  mode: "hybrid" | "keyword" | "semantic";
  projectPath?: string;
  query: string;
  sourceType?: "memory" | "session";
  updatedAfter?: string;
  updatedBefore?: string;
}

const agentLabels: Record<Agent, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
};

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function sourceLocation(path: string, location: string, endLocation?: string): string {
  const startLine = /^line:(\d+)$/u.exec(location)?.[1];
  const endLine = endLocation ? /^line:(\d+)$/u.exec(endLocation)?.[1] : undefined;
  const suffix = startLine && endLine
    ? `${startLine}-${endLine}`
    : endLocation && endLocation !== location
      ? `${location}-${endLocation}`
      : location.replace(/^line:/u, "");
  return suffix ? `${path}:${suffix}` : path;
}

export function SearchPage() {
  const [draft, setDraft] = useState("");
  const [agent, setAgent] = useState<Agent | "all">("all");
  const [sourceType, setSourceType] = useState<SearchParameters["sourceType"] | "all">("all");
  const [mode, setMode] = useState<SearchParameters["mode"]>("keyword");
  const [projectPath, setProjectPath] = useState("");
  const [updatedAfter, setUpdatedAfter] = useState("");
  const [updatedBefore, setUpdatedBefore] = useState("");
  const [parameters, setParameters] = useState<SearchParameters>();
  const search = useQuery({
    enabled: parameters !== undefined,
    queryFn: () => searchFragments(parameters!),
    queryKey: ["search", parameters],
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = draft.trim();
    if (!query) return;
    setParameters({
      agent: agent === "all" ? undefined : agent,
      mode,
      projectPath: projectPath.trim() || undefined,
      query,
      sourceType: sourceType === "all" ? undefined : sourceType,
      updatedAfter: updatedAfter ? new Date(updatedAfter).toISOString() : undefined,
      updatedBefore: updatedBefore ? new Date(updatedBefore).toISOString() : undefined,
    });
  }

  return (
    <section className="page search-page">
      <header className="page-header">
        <div>
          <h1>Search</h1>
          <p>检索已参与的 Session 和现有 Memory，并沿来源位置核对结果是否准确。</p>
        </div>
        <ServiceStatus />
      </header>

      <RerankerSettings onSaved={() => setParameters(undefined)} />

      <form className="search-console" onSubmit={submit} role="search">
        <div className="search-input-row">
          <Search aria-hidden="true" size={20} />
          <input
            aria-label="搜索证据"
            maxLength={300}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="输入关键词、文件名或代码符号"
            type="search"
            value={draft}
          />
          <button disabled={!draft.trim() || search.isFetching} type="submit">{search.isFetching ? "搜索中…" : "搜索"}</button>
        </div>
        <div className="search-filters">
          <label>
            <span>检索模式</span>
            <select aria-label="检索模式" onChange={(event) => setMode(event.target.value as SearchParameters["mode"])} value={mode}>
              <option value="keyword">关键词</option>
              <option value="semantic">语义</option>
              <option value="hybrid">混合</option>
            </select>
          </label>
          <label>
            <span>证据类型</span>
            <select aria-label="按证据类型筛选" onChange={(event) => setSourceType(event.target.value as SearchParameters["sourceType"] | "all")} value={sourceType}>
              <option value="all">Session + Memory</option>
              <option value="session">仅 Session</option>
              <option value="memory">仅 Memory</option>
            </select>
          </label>
          <label>
            <span>Agent</span>
            <select aria-label="按 Agent 筛选" onChange={(event) => setAgent(event.target.value as Agent | "all")} value={agent}>
              <option value="all">全部</option>
              {Object.entries(agentLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>
            <span>项目路径</span>
            <input aria-label="按项目路径筛选" onChange={(event) => setProjectPath(event.target.value)} placeholder="精确路径" value={projectPath} />
          </label>
          <label>
            <span>起始时间</span>
            <input aria-label="按起始时间筛选" onChange={(event) => setUpdatedAfter(event.target.value)} type="datetime-local" value={updatedAfter} />
          </label>
          <label>
            <span>截止时间</span>
            <input aria-label="按截止时间筛选" onChange={(event) => setUpdatedBefore(event.target.value)} type="datetime-local" value={updatedBefore} />
          </label>
          <span className="search-hint">过滤条件不会被静默放宽</span>
        </div>
      </form>

      <div className="content-panel search-results" aria-live="polite">
        <div className="panel-heading">
          <span>{parameters ? `“${parameters.query}” 的结果` : "检索结果"}</span>
          <span className="result-count">{search.data?.results.length ?? 0} 条证据</span>
        </div>
        {!parameters ? (
          <EmptyState description="输入一个关键词开始检索。结果会保留 Agent、项目路径、原始文件和文本位置。" icon={FileSearch} title="等待查询" />
        ) : null}
        {search.isLoading ? <p className="panel-message">正在检索本地索引…</p> : null}
        {search.isError ? <p className="panel-message panel-error">搜索失败：{search.error.message}</p> : null}
        {parameters && !search.isLoading && !search.isError && search.data?.results.length === 0 ? (
          <EmptyState description="尝试更短的关键词，或调整证据类型和 Agent 过滤条件。" icon={LibraryBig} title="没有匹配结果" />
        ) : null}
        {search.data?.results.map((result, index) => (
          <article className="evidence-row" key={result.fragmentId}>
            <div className="evidence-rank" aria-label={`结果 ${index + 1}`}>{String(index + 1).padStart(2, "0")}</div>
            <div className="evidence-body">
              <div className="evidence-title-line">
                <h2>{result.title ?? "未命名证据"}</h2>
                <span className={`source-chip source-${result.sourceType}`}>{result.sourceType === "session" ? "Session" : "Memory"}</span>
              </div>
              <div className="evidence-meta">
                <span>{agentLabels[result.agent]}</span>
                {result.role ? <span>{result.role === "assistant" ? "Agent 回复" : "用户消息"}</span> : null}
                <time dateTime={result.updatedAt}>{formatDate(result.updatedAt)}</time>
                <span>{{
                  "body match": "正文命中",
                  "hybrid match": "混合命中",
                  "keyword match": "关键词命中",
                  "semantic similarity": "语义相似",
                  "title match": "标题命中",
                }[result.matchReason] ?? result.matchReason}</span>
                {result.score !== undefined ? <span>分数 {result.score.toFixed(4)}</span> : null}
              </div>
              <p className="evidence-excerpt">{result.excerpt}</p>
              <div className="evidence-provenance">
                {result.projectPath ? <span title={result.projectPath}>{result.projectPath}</span> : null}
                {result.originalSessionId ? <span title={result.originalSessionId}>source session: {result.originalSessionId}</span> : null}
                <code title={sourceLocation(result.sourcePath, result.location, result.endLocation)}>
                  {sourceLocation(result.sourcePath, result.location, result.endLocation)}
                </code>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
