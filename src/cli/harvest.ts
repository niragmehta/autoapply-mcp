#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { closeWorkspace, getWorkspace } from "../config/load.js";
import { countHarvestedBoards, HARVEST_ATS, listHarvestRuns, matchingHarvestedBoards, type HarvestAts } from "../db/repositories/harvest.js";
import { scanHarvestedBoards, type ScanSummary } from "../sourcing/boardScan.js";
import { harvestBoards } from "../sourcing/commonCrawl.js";
import { toErrorMessage } from "../util/errors.js";

/**
 * Harvests ATS boards from the Common Crawl index and scans them for roles
 * that fit the campaign. Long-running by design - an MCP tool call would time
 * out - so it runs here, printing progress, and stops cleanly on Ctrl+C with
 * everything found so far kept.
 *
 *   npm run harvest -- --ats greenhouse --indexes 2 --scan
 *
 * This is a CLI, so writing to stdout is correct here.
 */

const USAGE = `Usage: npm run harvest -- [options]

  --ats <list>         ATS to harvest: ${HARVEST_ATS.join(",")} (default: all)
  --indexes <n>        read the newest n Common Crawl indexes (default 1)
  --index <ids>        explicit index ids, e.g. CC-MAIN-2026-43
  --max-pages <n>      read at most n pages per host query
  --scan               scan the harvested boards for fitting roles afterwards
  --scan-only          skip harvesting and only scan
  --limit <n>          boards to scan in this run (default 50)
  --rescan-days <n>    also rescan boards last scanned more than n days ago
  --status             print what has been harvested so far, then exit
  --help               this message`;

type Options = {
  ats: HarvestAts[];
  indexes: number;
  indexIds: string[];
  maxPages?: number;
  scan: boolean;
  scanOnly: boolean;
  limit: number;
  rescanDays?: number;
  status: boolean;
  help: boolean;
};

function positive(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} must be a whole number`);
  return parsed;
}

export function parseHarvestArgs(argv: readonly string[]): Options {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      ats: { type: "string" },
      indexes: { type: "string" },
      index: { type: "string" },
      "max-pages": { type: "string" },
      scan: { type: "boolean" },
      "scan-only": { type: "boolean" },
      limit: { type: "string" },
      "rescan-days": { type: "string" },
      status: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  const ats = (values.ats ?? HARVEST_ATS.join(","))
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const unknown = ats.filter((name) => !(HARVEST_ATS as readonly string[]).includes(name));
  if (unknown.length > 0) throw new Error(`unknown ATS: ${unknown.join(", ")} (choose from ${HARVEST_ATS.join(", ")})`);
  return {
    ats: ats as HarvestAts[],
    indexes: positive(values.indexes, "--indexes") ?? 1,
    indexIds: (values.index ?? "").split(",").map((id) => id.trim()).filter(Boolean),
    maxPages: positive(values["max-pages"], "--max-pages"),
    scan: values.scan === true || values["scan-only"] === true,
    scanOnly: values["scan-only"] === true,
    limit: positive(values.limit, "--limit") ?? 50,
    rescanDays: positive(values["rescan-days"], "--rescan-days"),
    status: values.status === true,
    help: values.help === true,
  };
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function printMatches(summary: ScanSummary): void {
  if (summary.matching.length === 0) {
    console.log("\nNo harvested board had a role that passes this campaign's gates.");
    return;
  }
  console.log(`\nCompanies with fitting roles (${summary.matching.length}):`);
  for (const board of summary.matching) {
    console.log(`  ${board.company} - ${board.ats}/${board.board}: ${board.matching} fitting of ${board.postings}`);
    for (const match of board.topMatches.slice(0, 3)) console.log(`      ${match.score.toFixed(0).padStart(3)}  ${match.title} | ${match.location}`);
  }
  console.log("\nThey are recorded as leads. Ask your agent to run propose_companies, then accept the ones you want.");
}

function printStatus(): void {
  const { db } = getWorkspace();
  console.log("Harvested boards by ATS and status:");
  for (const row of countHarvestedBoards(db)) console.log(`  ${row.ats.padEnd(11)} ${row.status.padEnd(9)} ${row.count}`);
  console.log("\nBest matching boards:");
  for (const board of matchingHarvestedBoards(db, 15)) console.log(`  ${board.company || board.board} - ${board.ats}/${board.board}: ${board.matching} fitting`);
  console.log("\nRecent runs:");
  for (const run of listHarvestRuns(db, 5)) console.log(`  ${run.startedAt} ${run.kind} ${run.status}`);
}

async function main(argv: readonly string[]): Promise<number> {
  const options = parseHarvestArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (options.status) {
    printStatus();
    return 0;
  }
  const workspace = getWorkspace();
  const controller = new AbortController();
  process.on("SIGINT", () => {
    if (controller.signal.aborted) process.exit(130);
    console.log(`\n${stamp()} stopping after the current request; press Ctrl+C again to quit at once`);
    controller.abort();
  });

  if (!options.scanOnly) {
    const summary = await harvestBoards(
      { db: workspace.db, companies: workspace.companies, ats: options.ats, indexes: options.indexes, indexIds: options.indexIds, maxPages: options.maxPages },
      (progress) => console.log(`${stamp()} ${progress.message}`),
      controller.signal,
    );
    console.log(`\nHarvest: ${summary.added} new board(s) from ${summary.pagesRead} page(s) of ${summary.indexes.join(", ") || "no index"}.`);
    for (const [ats, counts] of Object.entries(summary.byAts)) console.log(`  ${ats}: ${counts.seen} seen, ${counts.added} new`);
    for (const error of summary.errors.slice(0, 10)) console.log(`  error: ${error}`);
    if (summary.aborted) return 130;
  }
  if (options.scan) {
    const summary = await scanHarvestedBoards(
      workspace,
      { ats: options.ats, limit: options.limit, rescanAfterDays: options.rescanDays },
      (progress) => console.log(`${stamp()} ${progress.current ? `[${progress.current}/${progress.total}] ` : ""}${progress.message}`),
      controller.signal,
    );
    console.log(`\nScan: ${summary.scanned} board(s): ${Object.entries(summary.counts).map(([status, count]) => `${count} ${status}`).join(", ")}`);
    printMatches(summary);
    if (summary.aborted) return 130;
  }
  return 0;
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMain()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(toErrorMessage(error));
      console.error(USAGE);
      process.exitCode = 1;
    })
    .finally(() => closeWorkspace());
}
