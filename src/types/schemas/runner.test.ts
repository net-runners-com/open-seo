import { describe, expect, it } from "vitest";
import {
  runnerResultSchema,
  submitResultsRequestSchema,
} from "@/types/schemas/runner";

describe("runner schemas", () => {
  it("accepts a valid ok result", () => {
    const parsed = runnerResultSchema.parse({
      jobId: "job_1",
      status: "ok",
      position: 3,
      url: "https://example.com/a",
      serpFeatures: ["organic", "local_pack"],
      localPackPosition: null,
      errorMessage: null,
    });
    expect(parsed.position).toBe(3);
  });

  it("rejects position 0 and an empty batch", () => {
    expect(() =>
      runnerResultSchema.parse({
        jobId: "job_1",
        status: "ok",
        position: 0,
        url: null,
        serpFeatures: [],
        localPackPosition: null,
        errorMessage: null,
      }),
    ).toThrow();
    expect(() => submitResultsRequestSchema.parse({ results: [] })).toThrow();
  });
});
