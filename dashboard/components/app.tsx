import { useState } from "react";
import { Sidebar } from "./sidebar";
import type { PageId } from "./sidebar";
import { Topbar } from "./topbar";
import { UsagePage } from "./pages/usage";
import { ProvidersPage } from "./pages/providers";
import { CombosPage } from "./pages/combos";
import { SettingsPage } from "./pages/settings";

export default function App() {
  const [page, setPage] = useState<PageId>("usage");

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <Sidebar page={page} onNavigate={setPage} />
      <main className="flex min-w-0 flex-1 flex-col">
        <Topbar page={page} />
        <div className="flex-1 overflow-y-auto p-5 lg:p-8">
          <div className="mx-auto max-w-7xl space-y-5">
            {page === "usage" && <UsagePage />}
            {page === "providers" && <ProvidersPage />}
            {page === "combos" && <CombosPage />}
            {page === "settings" && <SettingsPage />}
          </div>
        </div>
      </main>
    </div>
  );
}