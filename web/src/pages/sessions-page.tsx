import { FolderSearch } from "lucide-react";

import { EmptyState } from "../components/empty-state.js";
import { ServiceStatus } from "../components/service-status.js";
import { Badge } from "@/components/ui/badge";

export function SessionsPage() {
  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>Session sources</h1>
          <p>查看 coding agent 的历史会话，并控制哪些来源进入本地索引。</p>
        </div>
        <ServiceStatus />
      </header>

      <div className="source-rail" aria-label="索引流程">
        <span>Source files</span><i /><span>Local index</span><i /><span>MCP results</span>
      </div>

      <div className="content-panel">
        <div className="panel-heading">
          <span>发现的 Session</span>
          <Badge className="count-badge" variant="secondary">0 sources</Badge>
        </div>
        <EmptyState
          description="完成首个来源 adapter 后，扫描到的 Session 会出现在这里。原始文件始终保持只读。"
          icon={FolderSearch}
          title="还没有发现 Session"
        />
      </div>
    </section>
  );
}
