/**
 * PCSX shapes trimmed from the live Qualcomm Eightfold tenant
 * (qualcomm.eightfold.ai, domain qualcomm.com), November 2026. The classic
 * `/api/apply/v2/jobs` shape follows the field names career-ops documents for
 * tenants not yet migrated (id, name, locations, t_create,
 * canonicalPositionUrl); no live v2 tenant was reachable for this fixture.
 */

export function pcsxPosition(overrides: Record<string, unknown> = {}) {
  return {
    id: 446718505618,
    displayJobId: "3091203",
    name: "Camera Subsystem Integration Lead",
    locations: ["San Diego, California, United States of America"],
    standardizedLocations: ["San Diego, CA, US"],
    postedTs: 1793923200,
    solrScore: null,
    stars: 0,
    department: "Camera Engineering",
    creationTs: 1778198400,
    isHot: 0,
    workLocationOption: "onsite",
    locationFlexibility: null,
    atsJobId: "3091203",
    positionUrl: "/careers/job/446718505618",
    ...overrides,
  };
}

export function pcsxSearch(positions: unknown[], count = positions.length) {
  return { status: 200, error: { message: "", body: "" }, data: { positions, filterDef: {}, count, sortBy: "relevance" }, metadata: {} };
}

export function pcsxDetail(overrides: Record<string, unknown> = {}) {
  return {
    status: 200,
    error: { message: "", body: "" },
    data: {
      ...pcsxPosition(),
      jobDescription: "<h2><b>Company:</b></h2>Qualcomm Technologies, Inc.<p>Pay range and other compensation: $156,800.00 - $235,200.00</p>",
      location: "San Diego, California, United States of America",
      publicUrl: "https://careers.qualcomm.com/careers/job/446718505618",
      ...overrides,
    },
    metadata: null,
  };
}

export const PCSX_NOT_FOUND = { status: 404, error: { message: "Position not found" }, data: {}, metadata: null };
export const NOT_PCSX = { message: "Not authorized for PCSX" };
export const PCSX_DISABLED = { message: "PCSX is not enabled for this user." };

export function v2Position(overrides: Record<string, unknown> = {}) {
  return {
    id: 790297654321,
    name: "Process Engineer",
    location: "Boise, Idaho, United States of America",
    locations: ["Boise, Idaho, United States of America"],
    t_create: 1793836800,
    t_update: 1793923200,
    canonicalPositionUrl: "https://careers.example.com/careers/job/790297654321",
    display_job_id: "JR12345",
    job_description: "<p>Own process control for a 300mm fab.</p>",
    ...overrides,
  };
}

export function v2Search(positions: unknown[], count = positions.length) {
  return { positions, count, domain: "example.com" };
}

export const CAREERS_PAGE = `<!doctype html><html><head><title>Careers at Micron Technology</title>
    <script>
      window._EF_GROUP_ID = "micron.com";
    </script></head><body></body></html>`;
