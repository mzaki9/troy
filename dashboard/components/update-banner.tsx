import { useState } from "react";
import { type UpdateStatus, useApi } from "./api";
import { CopyButton } from "./copy-button";

const UPGRADE_CMD = "npm i -g troy-proxy@latest";
const RELEASE_URL = "https://www.npmjs.com/package/troy-proxy";
const HIDE_KEY = "troy-hide-update";

export function UpdateBanner() {
  const { data } = useApi<UpdateStatus>("/api/update/status", { interval: 3_600_000 });
  const [hidden, setHidden] = useState<string | null>(() => {
    try {
      return localStorage.getItem(HIDE_KEY);
    } catch {
      return null;
    }
  });
  if (!data?.updateAvailable || !data.latest) return null;
  if (hidden === data.latest) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(HIDE_KEY, data.latest as string);
    } catch {}
    setHidden(data.latest);
  };
  return (
    <div className="mx-auto mt-4 w-full max-w-7xl px-5 lg:px-8">
      <div className="flex items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm">
        <span className="min-w-0 flex-1 truncate">
          troy {data.latest} available (running {data.current})
        </span>
        <code className="hidden font-mono text-xs opacity-80 sm:block">{UPGRADE_CMD}</code>
        <CopyButton what="troy-upgrade" text={UPGRADE_CMD} label="copy upgrade command" />
        <a href={RELEASE_URL} target="_blank" rel="noreferrer" className="underline underline-offset-2">
          release notes
        </a>
        <button
          type="button"
          onClick={dismiss}
          aria-label="dismiss update banner"
          className="opacity-70 hover:opacity-100"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
