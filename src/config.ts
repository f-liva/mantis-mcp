import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const configSchema = z.object({
  MANTIS_API_URL: z.string().url(),
  MANTIS_API_KEY: z.string().min(1),
  DB_PATH: z.string().default("./mantis-mcp.db"),
  EMBEDDING_MODEL: z
    .string()
    .default("Xenova/paraphrase-multilingual-MiniLM-L12-v2"),
  SYNC_BATCH_SIZE: z.coerce.number().int().positive().default(50),
  SYNC_ON_STARTUP: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${errors}`);
  }
  return result.data;
}
