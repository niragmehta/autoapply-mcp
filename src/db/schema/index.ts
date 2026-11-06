import type { SchemaModule } from "../migrate.js";
import { hygieneSchema } from "./hygiene.js";
import { evaluationSchema } from "./evaluation.js";
import { documentsSchema } from "./documents.js";
import { followupSchema } from "./followup.js";
import { careerSchema } from "./career.js";
import { sourcingSchema } from "./sourcing.js";
import { runnerSchema } from "./runner.js";

/** Feature schema modules, applied in this order after the core tables. */
export const FEATURE_SCHEMAS: readonly SchemaModule[] = [
  hygieneSchema,
  evaluationSchema,
  documentsSchema,
  followupSchema,
  careerSchema,
  sourcingSchema,
  runnerSchema,
];
