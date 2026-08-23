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
const cooldowns = CooldownStore.replay(store.foldStateEvents(), { append: (e) => store.appendStateEvent(e) }, (line) =>
  console.log(`  ${line}`),
);

// per-request routing trace — off by default, TROY_TRACE=1 for full play-by-play
const TRACE = process.env.TROY_TRACE === "1";

const { server } = buildTroyServer({ store, cooldowns, port: PORT, trace: TRACE, enableBackgroundTasks: true });

console.log(`troy → ${server.url}  proxy: ${server.url}v1  dashboard: ${server.url}`);
startModelsDevRefresh((msg) => console.log(`  ${msg}`));
if (!store.getDashPass()) {
  console.log(
    `  dashboard password: ${DEFAULT_DASHBOARD_PASS} (default — change it under Settings → Dashboard password)`,
  );
}
