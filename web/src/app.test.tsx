// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.js";

const api = vi.hoisted(() => ({
  excludeSession: vi.fn(),
  getHealth: vi.fn(),
  getIndexStatus: vi.fn(),
  getSessionConversation: vi.fn(),
  getSessions: vi.fn(),
  getSearchSettings: vi.fn(),
  indexSession: vi.fn(),
  restoreSession: vi.fn(),
  retryEmbeddings: vi.fn(),
  searchFragments: vi.fn(),
  updateSearchSettings: vi.fn(),
}));

vi.mock("./lib/api.js", () => api);

afterEach(cleanup);

function renderRoute(route: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getHealth.mockResolvedValue({
    database: "ok",
    service: "agent-memory-share-mcp",
    status: "ok",
    version: "0.0.0",
  });
  api.getIndexStatus.mockResolvedValue({ activeScanCheckpoints: 0, embedding: { indexed: 1 }, embeddingModelId: "test", fragments: 2, processing: { indexed: 1 } });
  api.getSessions.mockResolvedValue({ counts: { discovered: 0, excluded: 0, selected: 0 }, sessions: [], total: 0 });
  api.getSessionConversation.mockResolvedValue({
    messages: [],
    session: {
      agent: "codex",
      candidateId: "selected",
      disposition: "selected",
      indexStatus: "indexed",
      sessionId: "session-selected",
      sourcePath: "/sessions/selected.jsonl",
      updatedAt: "2026-10-15T09:00:00.000Z",
    },
  });
  api.excludeSession.mockResolvedValue({ candidateId: "selected", disposition: "excluded" });
  api.indexSession.mockResolvedValue({ candidateId: "discovered", fragmentCount: 2, sourcePath: "/sessions/new.jsonl" });
  api.restoreSession.mockResolvedValue({ candidateId: "excluded", fragmentCount: 2, sourcePath: "/sessions/old.jsonl" });
  api.searchFragments.mockResolvedValue({ results: [] });
  api.getSearchSettings.mockResolvedValue({ rerankerEnabled: false });
});

describe("App", () => {
  it("retries only failed embeddings", async () => {
    api.getIndexStatus.mockResolvedValue({ activeScanCheckpoints: 0, embedding: { failed: 1 }, embeddingModelId: "test", fragments: 2, processing: { indexed: 1 } });
    api.retryEmbeddings.mockResolvedValue({ attempted: 1, failed: 0, indexed: 1 });

    renderRoute("/search");
    fireEvent.click(await screen.findByRole("button", { name: "重试 1 个 embedding" }));
    await waitFor(() => expect(api.retryEmbeddings).toHaveBeenCalledOnce());
  });

  it("lists automatically admitted sessions and lets the user exclude a waiting session", async () => {
    api.getSessions.mockResolvedValue({
      counts: { discovered: 1, excluded: 0, selected: 1 },
      sessions: [
        {
          agent: "codex",
          candidateId: "selected",
          disposition: "selected",
          indexStatus: "indexed",
          projectPath: "/workspace/search",
          sessionId: "session-selected",
          sourcePath: "/sessions/selected.jsonl",
          title: "Improve evidence search",
          updatedAt: "2026-10-15T09:00:00.000Z",
        },
        {
          admissionReason: "capacity",
          agent: "claude-code",
          candidateId: "discovered",
          disposition: "discovered",
          indexStatus: "discovered",
          sessionId: "session-discovered",
          sourcePath: "/sessions/new.jsonl",
          title: "Review source adapters",
          updatedAt: "2026-10-14T09:00:00.000Z",
        },
      ],
      total: 2,
    });

    api.getIndexStatus.mockResolvedValue({ activeScanCheckpoints: 0, embedding: { indexed: 1 }, fragments: 2, processing: { indexed: 1 }, sessionCapacity: {
      codex: { fragmentLimit: 5000, fragments: 200, reservedFragments: 0, selectedSessions: 1, waitingSessions: 0 },
      "claude-code": { fragmentLimit: 5000, fragments: 5000, reservedFragments: 0, selectedSessions: 20, waitingSessions: 1 },
    } });
    renderRoute("/sessions");

    expect(await screen.findByText("Codex：200 / 5000 片段")).toBeInTheDocument();
    expect(await screen.findByText("Improve evidence search")).toBeInTheDocument();
    expect(screen.getByText("Review source adapters")).toBeInTheDocument();
    expect(screen.getByText("1 个已参与")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "剔除 Review source adapters" }));

    await waitFor(() => expect(api.excludeSession).toHaveBeenCalledWith("discovered"));
  });

  it("restores an excluded session without bypassing its capacity wait", async () => {
    const session = { agent: "codex", candidateId: "excluded", disposition: "excluded", indexStatus: "indexed", sessionId: "old", sourcePath: "/sessions/old.jsonl", title: "Older session", updatedAt: "2026-10-14T09:00:00.000Z" };
    api.getSessions.mockResolvedValue({ counts: { discovered: 0, excluded: 1, selected: 0 }, sessions: [session], total: 1 });
    api.restoreSession.mockImplementation(async () => {
      api.getSessions.mockResolvedValue({ counts: { discovered: 1, excluded: 0, selected: 0 }, sessions: [{ ...session, admissionReason: "capacity", disposition: "discovered", indexStatus: "discovered" }], total: 1 });
      return { candidateId: "excluded", disposition: "discovered", admissionReason: "capacity", fragmentCount: 0, sourcePath: session.sourcePath };
    });
    renderRoute("/sessions");

    fireEvent.click(await screen.findByRole("button", { name: "恢复 Older session" }));
    await waitFor(() => expect(api.restoreSession).toHaveBeenCalledWith("excluded"));
    expect(await screen.findByText("容量等待")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "剔除 Older session" })).toBeEnabled();
    expect(api.indexSession).not.toHaveBeenCalled();
  });

  it("submits a search and renders inspectable provenance", async () => {
    api.searchFragments.mockResolvedValue({
      results: [{
        agent: "codex",
        contentFingerprint: "fingerprint",
        endLocation: "line:44",
        excerpt: "搜索结果必须保留来源位置，才能人工判断准确度。",
        fragmentId: "fragment-1",
        location: "line:42",
        matchReason: "body match",
        projectPath: "/workspace/search",
        role: "assistant",
        sessionId: "session-1",
        sourceId: "source-1",
        sourcePath: "/sessions/session-1.jsonl",
        sourceType: "session",
        title: "Search evidence",
        updatedAt: "2026-10-15T09:00:00.000Z",
      }],
    });

    renderRoute("/search");
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索证据" }), { target: { value: "来源位置" } });
    fireEvent.change(screen.getByRole("combobox", { name: "检索模式" }), { target: { value: "hybrid" } });
    fireEvent.change(screen.getByRole("textbox", { name: "按项目路径筛选" }), { target: { value: "/workspace/search" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));

    expect(await screen.findByText("Search evidence")).toBeInTheDocument();
    expect(screen.getByText("搜索结果必须保留来源位置，才能人工判断准确度。")).toBeInTheDocument();
    expect(screen.getByText("/sessions/session-1.jsonl:42-44")).toBeInTheDocument();
    expect(api.searchFragments).toHaveBeenCalledWith({
      agent: undefined,
      mode: "hybrid",
      projectPath: "/workspace/search",
      query: "来源位置",
      sourceType: undefined,
      updatedAfter: undefined,
      updatedBefore: undefined,
    });
  });

  it("pages through the complete session inventory", async () => {
    api.getSessions.mockResolvedValue({
      counts: { discovered: 25, excluded: 0, selected: 1 },
      sessions: [],
      total: 26,
    });
    renderRoute("/sessions");

    const next = await screen.findByRole("button", { name: "下一页" });
    fireEvent.click(next);

    await waitFor(() => expect(api.getSessions).toHaveBeenLastCalledWith({
      agent: undefined,
      disposition: undefined,
      limit: 25,
      offset: 25,
    }));
  });

  it("opens a session and renders its visible conversation", async () => {
    api.getSessionConversation.mockResolvedValue({
      messages: [
        { body: "如何保留来源？", location: "line:12", role: "user" },
        { body: "每条结果都返回原文位置。", location: "line:18", role: "assistant" },
      ],
      session: {
        agent: "codex",
        candidateId: "selected",
        disposition: "discovered",
        indexStatus: "discovered",
        projectPath: "/workspace/search",
        sessionId: "session-selected",
        sourcePath: "/sessions/selected.jsonl",
        title: "Inspect provenance",
        updatedAt: "2026-10-15T09:00:00.000Z",
      },
    });

    renderRoute("/sessions/selected");

    expect(await screen.findByRole("heading", { name: "Inspect provenance" })).toBeInTheDocument();
    expect(screen.getByText("如何保留来源？")).toBeInTheDocument();
    expect(screen.getByText("每条结果都返回原文位置。")).toBeInTheDocument();
    expect(screen.getByText("line:18")).toBeInTheDocument();
    expect(api.getSessionConversation).toHaveBeenCalledWith("selected");
  });
});
