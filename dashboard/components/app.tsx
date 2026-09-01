import { useEffect, useState } from "react";
import { initDark } from "../dark";
import { api } from "./api";
import { LoginPage } from "./login";
import { CombosPage } from "./pages/combos";
import { ProvidersPage } from "./pages/providers";
import { SettingsPage } from "./pages/settings";
import { ToolsPage } from "./pages/tools";
import { UsagePage } from "./pages/usage";
import type { PageId } from "./sidebar";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

interface SessionInfo {
  authed: boolean;
  defaultPass: boolean;
}

function pageFromHash(): PageId {
  const h = location.hash.slice(1).split("/")[0];
  if ((["usage", "providers", "combos", "tools", "settings"] as const).includes(h as PageId)) return h as PageId;
  return "usage";
}
export default function App() {
  const [page, setPage] = useState<PageId>(() => pageFromHash());
  const [session, setSession] = useState<SessionInfo | null>(null);

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = (p: PageId) => {
    location.hash = p;
    setPage(p);
  };
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    initDark();
  }, []);

  useEffect(() => {
    api<SessionInfo>("/api/session")
      .then(setSession)
      .catch(() => setSession({ authed: false, defaultPass: true }));
  }, []);

  if (!session) {
    return <div className="dot-grid h-screen text-foreground" />;
  }

  if (!session.authed) {
    return <LoginPage defaultPass={session.defaultPass} onAuthed={() => setSession({ ...session, authed: true })} />;
  }

  return (
    <div className="dot-grid flex h-screen overflow-hidden text-foreground">
      <Sidebar
        page={page}
        onNavigate={(p) => {
          navigate(p);
          setDrawerOpen(false);
        }}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
      {drawerOpen ? (
        <button
          type="button"
          aria-label="close menu"
          onClick={() => setDrawerOpen(false)}
          className="fixed inset-0 z-30 bg-black/30 lg:hidden"
        />
      ) : null}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Topbar
          page={page}
          onLogout={() => setSession({ ...session, authed: false })}
          onMenu={() => setDrawerOpen((v) => !v)}
        />
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5 lg:p-8">
          <div key={page} className="view-switch mx-auto max-w-7xl space-y-5">
            {page === "usage" && <UsagePage />}
            {page === "providers" && <ProvidersPage />}
            {page === "combos" && <CombosPage />}
            {page === "tools" && <ToolsPage />}
            {page === "settings" && <SettingsPage />}
          </div>
        </div>
      </main>
    </div>
  );
}
