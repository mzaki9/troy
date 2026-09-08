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

/** opencode2 V2 header context for opencode/opencode-go prompt-cache routing.
 *  Mirrors the opencode2 binary builder verbatim:
 *  ox=(e,t)=>({"x-session-affinity":e.id,"X-Session-Id":e.id,...e.parentID?{"x-parent-session-id":e.parentID}:{},
 *  "User-Agent":ku(t),"x-opencode-project":e.projectID,"x-opencode-session":e.id,"x-opencode-client":t.name})
 *  with ku(e)=>`opencode/${e.channel}/${e.version}/${e.name}`.
 *  session/client/userAgent always resolved (synthesized when the caller
 *  sends none); project/parent forwarded only when present. */
export interface OpencodeContext {
  session: string;
  client: string;
  userAgent: string;
  project?: string;
  parent?: string;
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
  opencode?: OpencodeContext;
  onLog: (row: LogRow) => void;
  /** optional terminal trace for routing decisions (TROY_TRACE=1) */
  onTrace?: (line: string) => void;
}
export type ChatHandler = (body: Record<string, unknown>, deps: ChatDeps) => Promise<Response>;
