import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderSearch, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { EmptyState } from "../components/empty-state.js";
import { ServiceStatus } from "../components/service-status.js";
import {
  excludeSession,
  getSessions,
  indexSession,
  restoreSession,
  type Agent,
  type SessionCandidate,
} from "../lib/api.js";

const agentLabels: Record<Agent, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
};

const dispositionLabels = {
  discovered: "待选取",
  excluded: "已排除",
  selected: "已参与",
} as const;

const statusLabels: Record<SessionCandidate["indexStatus"], string> = {
  discovered: "等待索引",
  failed: "索引失败",
  indexed: "索引可用",
  indexing: "正在索引",
  source_changed: "来源已更新",
  source_unavailable: "来源不可用",
};

type SessionOperation = "exclude" | "index" | "restore";
const pageSize = 25;

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function actionFor(session: SessionCandidate): { label: string; operation: SessionOperation } {
  if (session.disposition === "discovered") return { label: "参与索引", operation: "index" };
  if (session.disposition === "excluded") return { label: "恢复", operation: "restore" };
  return { label: "排除", operation: "exclude" };
}

export function SessionsPage() {
  const queryClient = useQueryClient();
  const [agent, setAgent] = useState<Agent | "all">("all");
  const [disposition, setDisposition] = useState<SessionCandidate["disposition"] | "all">("all");
  const [page, setPage] = useState(0);
  const sessions = useQuery({
    queryFn: () => getSessions({
      agent: agent === "all" ? undefined : agent,
      disposition: disposition === "all" ? undefined : disposition,
      limit: pageSize,
      offset: page * pageSize,
    }),
    queryKey: ["sessions", agent, disposition, page],
  });
  const mutation = useMutation<void, Error, { candidateId: string; operation: SessionOperation }>({
    mutationFn: async ({ candidateId, operation }) => {
      if (operation === "index") {
        await indexSession(candidateId);
        return;
      }
      if (operation === "restore") {
        await restoreSession(candidateId);
        return;
      }
      await excludeSession(candidateId);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["sessions"] }),
        queryClient.invalidateQueries({ queryKey: ["search"] }),
      ]);
    },
  });
  const visibleSessions = useMemo(() => sessions.data?.sessions ?? [], [sessions.data?.sessions]);
  const selectedCount = sessions.data?.counts?.selected ?? 0;
  const pageCount = Math.max(1, Math.ceil((sessions.data?.total ?? 0) / pageSize));

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>Sessions</h1>
          <p>查看哪些会话已经参与检索，并控制本地派生索引。原始来源始终只读。</p>
        </div>
        <ServiceStatus />
      </header>

      <div className="toolbar">
        <div className="summary-line" aria-live="polite">
          <strong>{selectedCount} 个已参与</strong>
          <span>共发现 {sessions.data?.total ?? 0} 个 Session</span>
        </div>
        <div className="filters">
          <label>
            <span>Agent</span>
            <select aria-label="按 Agent 筛选" onChange={(event) => { setAgent(event.target.value as Agent | "all"); setPage(0); }} value={agent}>
              <option value="all">全部</option>
              {Object.entries(agentLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>
            <span>状态</span>
            <select aria-label="按参与状态筛选" onChange={(event) => { setDisposition(event.target.value as SessionCandidate["disposition"] | "all"); setPage(0); }} value={disposition}>
              <option value="all">全部</option>
              <option value="selected">已参与</option>
              <option value="discovered">待选取</option>
              <option value="excluded">已排除</option>
            </select>
          </label>
        </div>
      </div>

      <div className="content-panel">
        <div className="panel-heading">
          <span>Session 台账</span>
          <button className="icon-button" disabled={sessions.isFetching} onClick={() => void sessions.refetch()} type="button">
            <RotateCcw aria-hidden="true" size={14} />
            刷新
          </button>
        </div>
        {sessions.isLoading ? <p className="panel-message">正在读取本地 Session…</p> : null}
        {sessions.isError ? <p className="panel-message panel-error">读取失败：{sessions.error.message}</p> : null}
        {!sessions.isLoading && !sessions.isError && visibleSessions.length === 0 ? (
          <EmptyState
            description={disposition === "all" ? "运行一次来源扫描后，可用的 Session 会出现在这里。" : "当前筛选条件下没有 Session。"}
            icon={FolderSearch}
            title="没有可显示的 Session"
          />
        ) : null}
        {visibleSessions.length > 0 ? (
          <div className="session-list">
            {visibleSessions.map((session) => {
              const action = actionFor(session);
              const title = session.title ?? session.sessionId;
              const pending = mutation.isPending && mutation.variables.candidateId === session.candidateId;
              return (
                <article className={`session-row session-${session.disposition}`} key={session.candidateId}>
                  <div className="session-state">
                    <span className={`state-mark state-${session.disposition}`} />
                    <div>
                      <strong>{dispositionLabels[session.disposition]}</strong>
                      <span>{statusLabels[session.indexStatus]}</span>
                    </div>
                  </div>
                  <Link
                    aria-label={`查看对话 ${title}`}
                    className="session-main"
                    to={`/sessions/${session.candidateId}`}
                  >
                    <div className="session-title-line">
                      <h2>{title}</h2>
                      <span className="agent-label">{agentLabels[session.agent]}</span>
                    </div>
                    <p>{session.projectPath ?? "未提供项目路径"}</p>
                    <code title={session.sourcePath}>{session.sourcePath}</code>
                  </Link>
                  <div className="session-actions">
                    <time dateTime={session.updatedAt}>{formatDate(session.updatedAt)}</time>
                    <button
                      aria-label={`${action.label} ${title}`}
                      className={action.operation === "exclude" ? "text-button danger-button" : "text-button"}
                      disabled={pending || session.indexStatus === "source_unavailable"}
                      onClick={() => mutation.mutate({ candidateId: session.candidateId, operation: action.operation })}
                      type="button"
                    >
                      {pending ? "处理中…" : action.label}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : null}
        {(sessions.data?.total ?? 0) > pageSize ? (
          <nav aria-label="Session 分页" className="pagination">
            <button disabled={page === 0 || sessions.isFetching} onClick={() => setPage((value) => value - 1)} type="button">上一页</button>
            <span>第 {page + 1} / {pageCount} 页</span>
            <button disabled={page + 1 >= pageCount || sessions.isFetching} onClick={() => setPage((value) => value + 1)} type="button">下一页</button>
          </nav>
        ) : null}
      </div>
      {mutation.isError ? <p className="action-error" role="alert">操作失败：{mutation.error.message}</p> : null}
    </section>
  );
}
