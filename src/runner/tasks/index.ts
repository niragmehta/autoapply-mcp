import type { RunQueue } from "../queue.js";
import { DiscoveryParamsSchema, runDiscoveryTask } from "./discovery.js";
import { registerFeatureTasks } from "./features.js";
import { PrepareParamsSchema, runPrepareTask } from "./prepare.js";
import { SubmitParamsSchema, runSubmitTask } from "./submit.js";

/** The run types every host offers. One of each runs at a time per host. */
export function registerBuiltinTasks(queue: RunQueue): void {
  queue.registerTask("discovery", runDiscoveryTask, {
    params: DiscoveryParamsSchema,
    description: "Fetch, gate and score postings from configured boards, in chunks.",
  });
  queue.registerTask("prepare", runPrepareTask, {
    params: PrepareParamsSchema,
    description: "Draft applications for chosen jobs or a queue filter; reports ready vs needs-human.",
  });
  queue.registerTask("submit", runSubmitTask, {
    params: SubmitParamsSchema,
    description: "Approve and submit an explicit list of applications, paced and round-capped.",
  });
  registerFeatureTasks(queue);
}
