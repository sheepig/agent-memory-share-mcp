import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getSearchSettings, updateSearchSettings } from "../lib/api.js";

export function RerankerSettings({ onSaved }: { onSaved: () => void }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryFn: getSearchSettings, queryKey: ["search-settings"] });
  const save = useMutation({
    mutationFn: updateSearchSettings,
    onSuccess: (value) => {
      queryClient.setQueryData(["search-settings"], value);
      void queryClient.invalidateQueries({ queryKey: ["search"], refetchType: "none" });
      onSaved();
    },
  });

  return (
    <section aria-label="检索设置" className="reranker-settings">
      <div className="reranker-setting-row">
        <label htmlFor="reranker-enabled">本地重排（reranker）</label>
        <input
          aria-describedby="reranker-description"
          aria-label="启用本地 reranker"
          checked={save.isPending ? save.variables.rerankerEnabled : settings.data?.rerankerEnabled ?? false}
          disabled={!settings.data || settings.isError || save.isPending}
          id="reranker-enabled"
          onChange={(event) => save.mutate({ rerankerEnabled: event.target.checked })}
          role="switch"
          type="checkbox"
        />
        <span aria-live="polite">{save.isPending ? "正在保存…" : settings.isLoading ? "正在读取…" : settings.data ? settings.data.rerankerEnabled ? "已启用" : "已关闭" : "读取失败"}</span>
      </div>
      <p id="reranker-description">保存到本地配置，对下一次 Web、CLI 和 MCP 搜索统一生效。启用后搜索耗时会增加，首次搜索可能需要下载并加载本地模型。</p>
      {settings.isError ? <p className="action-error" role="alert">读取配置失败：{settings.error.message}</p> : null}
      {save.isError ? <p className="action-error" role="alert">保存配置失败：{save.error.message}</p> : null}
    </section>
  );
}
