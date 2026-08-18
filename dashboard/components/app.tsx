import { useEffect, useState } from "react";
import { Sidebar } from "./sidebar";
import type { PageId } from "./sidebar";
import { Topbar } from "./topbar";
import { UsagePage } from "./pages/usage";
import { ProvidersPage } from "./pages/providers";
import { CombosPage } from "./pages/combos";
import { ToolsPage } from "./pages/tools";
import { SettingsPage } from "./pages/settings";
import { initDark } from "../dark";

export default function App() {
  const [page, setPage] = useState<PageId>("usage");

  useEffect(() => {
    initDark();
  }, []);

  return (
    <div className="dot-grid flex h-screen overflow-hidden text-foreground">
      <Sidebar page={page} onNavigate={setPage} />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Topbar page={page} />
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