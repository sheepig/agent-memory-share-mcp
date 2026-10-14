// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { App } from "./app.js";

vi.mock("./lib/api.js", () => ({
  getHealth: vi.fn().mockResolvedValue({
    database: "ok",
    service: "agent-memory-share-mcp",
    status: "ok",
    version: "0.0.0",
  }),
}));

describe("App", () => {
  it("renders the Session management route", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/sessions"]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByRole("heading", { name: "Session sources" })).toBeInTheDocument();
    expect(await screen.findByText("本地服务已连接")).toBeInTheDocument();
  });
});
