import { Search, LibraryBig } from "lucide-react";

import { EmptyState } from "../components/empty-state.js";
import { ServiceStatus } from "../components/service-status.js";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

export function MemoriesPage() {
  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>Search memory</h1>
          <p>同时检索未排除的 Session 片段和 Agent 已生成的 Memory。</p>
        </div>
        <ServiceStatus />
      </header>

      <label className="search-field">
        <Search aria-hidden="true" size={19} />
        <Input aria-label="搜索记忆" disabled placeholder="输入关键词、文件名或代码符号" />
        <kbd>⌘ K</kbd>
      </label>

      <div className="content-panel">
        <div className="panel-heading">
          <span>检索结果</span>
          <Badge className="count-badge" variant="secondary">Session + Memory</Badge>
        </div>
        <EmptyState
          description="搜索索引接入后，可按时间、Agent、项目路径和证据类型过滤结果。"
          icon={LibraryBig}
          title="索引尚未建立"
        />
      </div>
    </section>
  );
}
