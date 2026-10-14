import { Database, FolderClock, Search } from "lucide-react";
import { Navigate, NavLink, Route, Routes } from "react-router-dom";

import { cn } from "./lib/utils.js";
import { MemoriesPage } from "./pages/memories-page.js";
import { SessionsPage } from "./pages/sessions-page.js";

const navigation = [
  { icon: FolderClock, label: "Sessions", to: "/sessions" },
  { icon: Search, label: "Memories", to: "/memories" },
] as const;

export function App() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-mark" aria-label="Agent Memory">
          <Database aria-hidden="true" size={18} />
          <span>Agent Memory</span>
        </div>
        <nav aria-label="主要导航" className="nav-list">
          {navigation.map(({ icon: Icon, label, to }) => (
            <NavLink
              className={({ isActive }) => cn("nav-link", isActive && "nav-link-active")}
              key={to}
              to={to}
            >
              <Icon aria-hidden="true" size={17} />
              {label}
            </NavLink>
          ))}
        </nav>
        <p className="sidebar-note">Local evidence index</p>
      </aside>

      <main className="workspace">
        <Routes>
          <Route element={<Navigate replace to="/sessions" />} path="/" />
          <Route element={<SessionsPage />} path="/sessions" />
          <Route element={<MemoriesPage />} path="/memories" />
        </Routes>
      </main>
    </div>
  );
}
