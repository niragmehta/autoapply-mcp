import type { Router } from "../router.js";
import { registerRoutes as analytics } from "./analytics.js";
import { registerRoutes as applications } from "./applications.js";
import { registerRoutes as artifacts } from "./artifacts.js";
import { registerRoutes as career } from "./career.js";
import { registerRoutes as companies } from "./companies.js";
import { registerRoutes as documents } from "./documents.js";
import { registerRoutes as events } from "./events.js";
import { registerRoutes as followups } from "./followups.js";
import { registerRoutes as health } from "./health.js";
import { registerRoutes as inbox } from "./inbox.js";
import { registerRoutes as jobs } from "./jobs.js";
import { registerRoutes as leads } from "./leads.js";
import { registerRoutes as needsHuman } from "./needsHuman.js";
import { registerRoutes as reports } from "./reports.js";
import { registerRoutes as runs } from "./runs.js";
import { registerRoutes as status } from "./status.js";

/**
 * Every API module. A new area adds one file under api/ exporting
 * `registerRoutes(router)` and one entry here.
 */
export const API_MODULES: ReadonlyArray<(router: Router) => void> = [
  status,
  jobs,
  applications,
  needsHuman,
  documents,
  inbox,
  followups,
  career,
  analytics,
  reports,
  artifacts,
  companies,
  leads,
  runs,
  events,
  health,
];

export function registerApiRoutes(router: Router, modules: ReadonlyArray<(router: Router) => void> = API_MODULES): Router {
  for (const register of modules) register(router);
  return router;
}
