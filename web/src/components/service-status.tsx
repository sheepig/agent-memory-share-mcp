import { useQuery } from "@tanstack/react-query";

import { getHealth } from "../lib/api.js";

export function ServiceStatus() {
  const health = useQuery({ queryFn: getHealth, queryKey: ["health"] });
  const online = health.data?.status === "ok";

  return (
    <div className="service-status" role="status">
      <span className={online ? "status-dot status-dot-online" : "status-dot"} />
      <span>{health.isLoading ? "正在连接本地服务" : online ? "本地服务已连接" : "本地服务不可用"}</span>
      {online ? <code>v{health.data?.version}</code> : null}
    </div>
  );
}
