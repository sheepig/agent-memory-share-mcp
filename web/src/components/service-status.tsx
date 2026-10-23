import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getHealth, getIndexStatus, retryEmbeddings } from "../lib/api.js";

export function ServiceStatus() {
  const health = useQuery({ queryFn: getHealth, queryKey: ["health"] });
  const index = useQuery({ enabled: health.data?.status === "ok", queryFn: getIndexStatus, queryKey: ["index-status"], refetchInterval: 5_000 });
  const queryClient = useQueryClient();
  const retry = useMutation({
    mutationFn: retryEmbeddings,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["index-status"] }),
  });
  const online = health.data?.status === "ok";
  const failedEmbeddings = index.data?.embedding.failed ?? 0;

  return (
    <div className="service-status" role="status">
      <span className={online ? "status-dot status-dot-online" : "status-dot"} />
      <span>{health.isLoading ? "正在连接本地服务" : online ? "本地服务已连接" : "本地服务不可用"}</span>
      {online ? <code>v{health.data?.version}</code> : null}
      {index.data ? <span>{index.data.fragments} fragments</span> : null}
      {failedEmbeddings > 0 ? (
        <button disabled={retry.isPending} onClick={() => retry.mutate()} type="button">
          {retry.isPending ? "正在重试" : `重试 ${failedEmbeddings} 个 embedding`}
        </button>
      ) : null}
    </div>
  );
}
