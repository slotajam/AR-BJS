import { describe, expect, it } from "vitest";
import type { AnalyticsPoint } from "./api";
import { buildTraces, fmtScore } from "./viz";

const pt = (id: string, year: number | null, score: number | null, rt = "discovery"): AnalyticsPoint => ({
  paper_id: id, title: id, doi: null, publication_year: year, relevance_score: score, lexical: null, semantic: null,
  embedding_pc1: 1, embedding_pc2: 2, embedding_pc3: null, access_status: "unavailable", record_type: rt,
  source: "openalex", is_fixture: true,
});

describe("buildTraces", () => {
  it("omits points with missing axis values and reports them per axis", () => {
    const d = buildTraces([pt("a", 2020, 0.5), pt("b", null, 0.2), pt("c", 2021, null, "collected")],
      { x: "publication_year", y: "relevance_score", color: "record_type" }, new Set(), false);
    expect(d.plotted).toBe(1);
    expect(d.omitted).toBe(2);
    expect(d.omittedByAxis).toEqual({ publication_year: 1, relevance_score: 1 });
    expect(d.traces[0].type).toBe("scattergl");
  });

  it("uses the z axis only in 3D mode and highlights selection", () => {
    const pts = [pt("a", 2020, 0.5), pt("b", 2021, 0.6)];
    const d3 = buildTraces(pts, { x: "embedding_pc1", y: "embedding_pc2", z: "embedding_pc3", color: "source" },
      new Set(["a"]), true);
    expect(d3.plotted).toBe(0); // pc3 is null for all
    const d2 = buildTraces(pts, { x: "embedding_pc1", y: "embedding_pc2", z: "embedding_pc3", color: "source" },
      new Set(["a"]), false);
    expect(d2.plotted).toBe(2);
    expect((d2.traces[0].marker as { size: number[] }).size).toEqual([11, 6]);
  });

  it("formats missing scores explicitly", () => {
    expect(fmtScore(null)).toBe("—");
    expect(fmtScore(0.12345)).toBe("0.123");
  });
});
