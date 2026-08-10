import type { MessageAnalysis } from "@wagi/contracts";

export const analysisSchema = {
  type: "object",
  required: ["messageId", "relevant", "relevanceScore", "summary", "facts", "entities", "events", "places", "model"],
  properties: {
    messageId: { type: "string" },
    relevant: { type: "boolean" },
    relevanceScore: { type: "number", minimum: 0, maximum: 1 },
    summary: { type: "string" },
    facts: { type: "array" },
    entities: { type: "array" },
    events: { type: "array" },
    places: { type: "array" },
    schemaVersion: { type: "string" },
    promptVersion: { type: "string" },
    provenance: { type: "array" },
    conflicts: { type: "array" },
    model: { type: "string" },
  },
} as const;

export type StructuredAnalysis = MessageAnalysis;
