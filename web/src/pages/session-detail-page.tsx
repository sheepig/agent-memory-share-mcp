import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, MessageSquareText } from "lucide-react";
import { Link, useParams } from "react-router-dom";

import { EmptyState } from "../components/empty-state.js";
import { ServiceStatus } from "../components/service-status.js";
import { getSessionConversation, type Agent } from "../lib/api.js";

const agentLabels: Record<Agent, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
};

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "long",
    timeStyle: "short",
  }).format(new Date(value));
}

export function SessionDetailPage() {
  const { candidateId } = useParams();
  const conversation = useQuery({
    enabled: Boolean(candidateId),
    queryFn: () => getSessionConversation(candidateId!),
    queryKey: ["session-conversation", candidateId],
  });

  return (
    <section className="page session-detail-page">
      <div className="detail-topline">
        <Link className="back-link" to="/sessions">
          <ArrowLeft aria-hidden="true" size={15} />
          返回 Sessions
        </Link>
        <ServiceStatus />
      </div>

      {conversation.isLoading ? <p className="panel-message">正在读取 Session 对话…</p> : null}
      {conversation.isError ? (
        <div className="content-panel detail-error">
          <p className="panel-message panel-error">读取失败：{conversation.error.message}</p>
          <Link className="text-button" to="/sessions">返回 Session 列表</Link>
        </div>
      ) : null}

      {conversation.data ? (
        <>
          <header className="detail-header">
            <div>
              <div className="detail-title-line">
                <h1>{conversation.data.session.title ?? conversation.data.session.sessionId}</h1>
                <span className="agent-label">{agentLabels[conversation.data.session.agent]}</span>
              </div>
              <p>只读展示来源中可见的用户消息与 Agent 最终回复。</p>
            </div>
          </header>

          <div className="conversation-layout">
            <aside className="session-metadata" aria-label="Session 来源信息">
              <dl>
                <div>
                  <dt>更新时间</dt>
                  <dd><time dateTime={conversation.data.session.updatedAt}>{formatDate(conversation.data.session.updatedAt)}</time></dd>
                </div>
                <div>
                  <dt>项目路径</dt>
                  <dd>{conversation.data.session.projectPath ?? "未提供"}</dd>
                </div>
                <div>
                  <dt>Session ID</dt>
                  <dd><code>{conversation.data.session.sessionId}</code></dd>
                </div>
                <div>
                  <dt>来源路径</dt>
                  <dd><code>{conversation.data.session.sourcePath}</code></dd>
                </div>
              </dl>
            </aside>

            <div className="conversation-panel">
              <div className="conversation-heading">
                <span>对话</span>
                <span>{conversation.data.messages.length} 条可见消息</span>
              </div>
              {conversation.data.messages.length === 0 ? (
                <EmptyState
                  description="来源中没有可展示的用户消息或 Agent 最终回复。"
                  icon={MessageSquareText}
                  title="没有可见对话"
                />
              ) : (
                <div className="message-list">
                  {conversation.data.messages.map((message, index) => (
                    <article className={`message-block message-${message.role}`} key={`${message.location}-${index}`}>
                      <header>
                        <strong>{message.role === "user" ? "用户" : agentLabels[conversation.data.session.agent]}</strong>
                        <code>{message.location}</code>
                      </header>
                      <p>{message.body}</p>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}
