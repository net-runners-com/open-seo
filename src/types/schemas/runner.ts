import { z } from "zod";

const positionSchema = z.number().int().positive().nullable();

export const runnerJobSchema = z.object({
  id: z.string(),
  runId: z.string(),
  keyword: z.string(),
  device: z.enum(["desktop", "mobile"]),
  includeLocalPack: z.boolean(),
  targetDomain: z.string(),
  languageCode: z.string(),
  locationCode: z.number().int(),
  locationName: z.string().nullable(),
  serpDepth: z.number().int().positive(),
});
export type RunnerJob = z.infer<typeof runnerJobSchema>;

export const runnerResultSchema = z.object({
  jobId: z.string(),
  status: z.enum(["ok", "error"]),
  position: positionSchema,
  url: z.string().nullable(),
  serpFeatures: z.array(z.string()).max(30),
  localPackPosition: positionSchema,
  errorMessage: z.string().max(2000).nullable(),
});
export type RunnerResult = z.infer<typeof runnerResultSchema>;

export const submitResultsRequestSchema = z.object({
  results: z.array(runnerResultSchema).min(1).max(50),
});

export const heartbeatRequestSchema = z.object({
  status: z.enum(["idle", "scraping", "cooldown"]),
});
export type RunnerHeartbeatStatus = z.infer<
  typeof heartbeatRequestSchema
>["status"];
