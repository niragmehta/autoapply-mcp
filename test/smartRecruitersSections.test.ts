import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanySchema } from "../src/domain/campaign.js";
import { smartrecruitersAdapter } from "../src/sources/smartrecruiters.js";
import { fetchJson } from "../src/sources/http.js";

vi.mock("../src/sources/http.js", () => ({ fetchJson: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const company = CompanySchema.parse({ name: "Acme", ats: "smartrecruiters", board: "Acme" });

describe("SmartRecruiters non-text ad sections", () => {
  it("retains job text when a separate videos section has no text field", async () => {
    vi.mocked(fetchJson).mockResolvedValueOnce({ content: [{ id: "1", name: "Senior Software Engineer" }], totalFound: 1 })
      .mockResolvedValueOnce({
        id: "1", name: "Senior Software Engineer",
        location: { city: "Santa Clara", region: "CA", country: "us" },
        jobAd: { sections: {
          jobDescription: { text: "<p>Build secure backend systems.</p>" },
          videos: { urls: ["https://video.example/watch"] },
        } },
      });
    const [job] = await smartrecruitersAdapter.listJobs(company, new Date().toISOString());
    expect(job?.descriptionText).toBe("Build secure backend systems.");
    expect(vi.mocked(fetchJson)).toHaveBeenCalledTimes(2);
  });

  it("still rejects ads with no textual job content", async () => {
    vi.mocked(fetchJson).mockResolvedValueOnce({ content: [{ id: "1", name: "Engineer" }], totalFound: 1 })
      .mockResolvedValueOnce({
        id: "1", name: "Engineer", location: { country: "us" },
        jobAd: { sections: { videos: { urls: ["https://video.example/watch"] } } },
      });
    await expect(smartrecruitersAdapter.listJobs(company, new Date().toISOString())).rejects.toThrow(/schema/);
  });
});
