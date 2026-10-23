// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RerankerSettings } from "./reranker-settings.js";

const api = vi.hoisted(() => ({ getSearchSettings: vi.fn(), updateSearchSettings: vi.fn() }));
vi.mock("../lib/api.js", () => api);
afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  api.getSearchSettings.mockResolvedValue({ rerankerEnabled: false });
});

function show(onSaved = vi.fn()) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <RerankerSettings onSaved={onSaved} />
  </QueryClientProvider>);
}

describe("reranker settings", () => {
  it("persists the switch and restores the saved value when reopened", async () => {
    api.updateSearchSettings.mockResolvedValue({ rerankerEnabled: true });
    const onSaved = vi.fn();
    const first = show(onSaved);
    const toggle = await screen.findByRole("switch", { name: "启用本地 reranker" });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(api.updateSearchSettings).toHaveBeenCalledOnce();
    expect(api.updateSearchSettings.mock.calls[0]?.[0]).toEqual({ rerankerEnabled: true });
    expect(onSaved).toHaveBeenCalledOnce();
    first.unmount();
    api.getSearchSettings.mockResolvedValue({ rerankerEnabled: true });
    show();
    await waitFor(() => expect(screen.getByRole("switch", { name: "启用本地 reranker" })).toBeChecked());
  });

  it("keeps the saved state and shows a failed write", async () => {
    api.updateSearchSettings.mockRejectedValue(new Error("Configuration is not writable"));
    const onSaved = vi.fn();
    show(onSaved);
    const toggle = await screen.findByRole("switch", { name: "启用本地 reranker" });
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    expect(await screen.findByRole("alert")).toHaveTextContent("Configuration is not writable");
    expect(toggle).not.toBeChecked();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
