import { z } from "zod";
import { artifactContentType, isArtifactName, resolveArtifact } from "../queries/artifacts.js";
import { FileReply, HttpError, parseParams, type Router } from "../router.js";

/** Screenshots from the artifacts directory, by validated file name only. */

const ArtifactParams = z.object({ name: z.string().max(200).refine(isArtifactName, "not a screenshot name") });

export function registerRoutes(router: Router): void {
  router.get("/api/artifacts/:name", (request) => {
    const { name } = parseParams(ArtifactParams, request);
    const path = resolveArtifact(request.ctx.workspace().paths.artifacts, name);
    if (!path) throw new HttpError(404, "artifact_not_found", "no screenshot with that name");
    return new FileReply(path, artifactContentType(name));
  });
}
