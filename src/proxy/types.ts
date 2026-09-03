// ponytail: ChatDeps only; add Provider/Connection re-exports when graph needs them — minimal diff, no runtime change

import type { Store } from "../store/db";
import type { CooldownStore } from "./cooldown";

export interface LogRow {
  provider: string;
  model: string;
  combo?: string;
  status: string;
  latency_ms: number;
  tokens?: Record<string, number>;
  /** RTK compressor: chars removed / chars that entered it (0 when off or no hit) */
  rtk_saved?: number;
  rtk_seen?: number;
  request_id?: string | null;
}

export interface ChatDeps {
  store: Store;
  cooldowns: CooldownStore;
  strategy: string;
  rtkOn: boolean;
  cavemanLevel: string;
  ponytailLevel: string;
  signal?: AbortSignal;
  requestId?: string;
  /** Session-affinity value for opencode/opencode-go prompt-cache routing (x-opencode-session). */
  opencodeSession?: string;
  onLog: (row: LogRow) => void;
  /** optional terminal trace for routing decisions (TROY_TRACE=1) */
  onTrace?: (line: string) => void;
}
export type ChatHandler = (body: Record<string, unknown>, deps: ChatDeps) => Promise<Response>;
