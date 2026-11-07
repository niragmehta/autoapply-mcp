#!/usr/bin/env node
import { resolvePaths } from "../config/paths.js";
import { loadSecretsFile } from "../config/secrets.js";
import { startDashboard } from "../dashboard/server.js";
import { DEFAULT_PORT } from "../dashboard/security.js";
import { openDatabase } from "../db/database.js";
import { createRunQueue, freshWorkspace, setRunQueue } from "../runner/index.js";
import { toErrorMessage } from "../util/errors.js";

/**
 * Starts the local dashboard and hosts the run queue for as long as it runs.
 *
 *   npm run dashboard [-- --port 4317] [--host 127.0.0.1]
 *
 * This is a CLI, so writing to stdout is correct here. It prints the sign-in
 * link (which carries the per-start token) and never prints secret values.
 */

/** A first Ctrl+C lets runs finish the application in hand; it can take this long. */
const GRACEFUL_STOP_MS = 30 * 60_000;

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`invalid port "${raw}"`);
  return port;
}

async function main(): Promise<void> {
  const paths = resolvePaths();
  const applied = loadSecretsFile(paths.secrets);
  const port = parsePort(argValue("--port") ?? process.env.AUTOAPPLY_DASHBOARD_PORT);
  const host = argValue("--host") ?? "127.0.0.1";

  const queue = createRunQueue({ db: openDatabase(paths.database) });
  setRunQueue(queue);
  const recovered = queue.recover();
  queue.start();

  console.log(`autoapply dashboard\nhome: ${paths.home}`);
  if (applied.length > 0) console.log(`secrets: ${applied.length} value(s) loaded from ${paths.secrets}`);
  try {
    freshWorkspace();
  } catch (error) {
    console.log(`\nConfiguration problem: ${toErrorMessage(error)}\nThe dashboard still starts; its Health page shows the details.`);
  }
  if (recovered.length > 0) console.log(`Marked ${recovered.length} run(s) from a stopped session as interrupted.`);

  const dashboard = await startDashboard({ port, host, queue });
  const fixedToken = Boolean(process.env.AUTOAPPLY_DASHBOARD_TOKEN?.trim());
  console.log(
    `\nOpen this link to sign in (${fixedToken ? "fixed by AUTOAPPLY_DASHBOARD_TOKEN" : "it changes on every start"}):\n  ${dashboard.loginUrl}\n`,
  );
  console.log("Ctrl+C stops after running runs finish the item in hand; press it again to stop at once.");

  let stopping = false;
  const stop = () => {
    if (stopping) {
      console.log("Stopping now. Unfinished runs are marked interrupted.");
      queue.forceInterrupt();
      process.exit(130);
    }
    stopping = true;
    const active = queue.activeRunIds().length;
    console.log(active > 0 ? `Waiting for ${active} run(s) to reach a safe stopping point...` : "Stopping...");
    void (async () => {
      await queue.shutdown(GRACEFUL_STOP_MS);
      await dashboard.close();
      process.exit(0);
    })();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((error: unknown) => {
  console.error(toErrorMessage(error));
  process.exitCode = 1;
});
