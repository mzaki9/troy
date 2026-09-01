import { mkdirSync } from "node:fs";
import { buildTroyServer } from "./app";
import { DEFAULT_DASHBOARD_PASS } from "./dash/auth";
import { startModelsDevRefresh } from "./modelsdev";
import { CooldownStore } from "./proxy/cooldown";
import { Store } from "./store/db";

const PORT = Number(process.env.PORT ?? 31337);
const DATA_DIR = process.env.TROY_DATA ?? "data";

mkdirSync(DATA_DIR, { recursive: true });
const store = new Store(`${DATA_DIR}/troy.db`);
store.startLogFlush(2000);
// fold the durable state_events log back into live cooldowns/breakers (restart recovery)
// rrChain persisted in kv so round-robin rotation survives restarts
const cooldowns = CooldownStore.replay(
  store.foldStateEvents(),
  { append: (e) => store.appendStateEvent(e) },
  (line) => console.log(`  ${line}`),
  { get: (n) => store.getNextChainStart(n), set: (n, v) => store.setNextChainStart(n, v) },
);

// per-request routing trace — off by default, TROY_TRACE=1 for full play-by-play
const TRACE = process.env.TROY_TRACE === "1";

const { server, shutdown } = buildTroyServer({
  store,
  cooldowns,
  port: PORT,
  trace: TRACE,
  enableBackgroundTasks: true,
});

console.log(`troy → ${server.url}  proxy: ${server.url}v1  dashboard: ${server.url}`);
startModelsDevRefresh((msg) => console.log(`  ${msg}`));
if (!store.getDashPass()) {
  console.log(
    `  dashboard password: ${DEFAULT_DASHBOARD_PASS} (default — change it under Settings → Dashboard password)`,
  );
}

let shuttingDown = false;
function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] ${signal} received, draining...`);
  try {
    shutdown();
  } catch {}
  try {
    store.stopLogFlush();
  } catch {}
  try {
    const s = server as unknown as { stop?: (force?: boolean) => void };
    if (typeof s.stop === "function") {
      try {
        s.stop(true);
      } catch {
        try {
          s.stop();
        } catch {}
      }
    }
  } catch {}
  try {
    store.close();
  } catch {}
  setTimeout(() => {
    console.log("[shutdown] complete");
    process.exit(0);
  }, 500).unref?.();
  setTimeout(() => {
    console.error("[shutdown] forced exit after 10s");
    process.exit(1);
  }, 10_000).unref?.();
}
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
