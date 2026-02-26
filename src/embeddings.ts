import type { Config } from "./config.js";
import { logger } from "./logger.js";

// Suppress Transformers.js console output (would corrupt MCP stdout)
// We must set this BEFORE importing transformers
process.env.TRANSFORMERS_JS_LOG_LEVEL = "error";

type Pipeline = (
  texts: string[],
  options?: { pooling: string; normalize: boolean }
) => Promise<{ data: Float32Array; dims: number[] }>;

let pipeline: Pipeline | null = null;
let modelName: string = "";

const SUB_BATCH_SIZE = 32;

export async function initEmbeddings(config: Config): Promise<void> {
  modelName = config.EMBEDDING_MODEL;
  logger.info(`Embedding model configured: ${modelName} (lazy-loaded)`);
}

async function getPipeline(): Promise<Pipeline> {
  if (pipeline) return pipeline;

  logger.info(`Loading embedding model: ${modelName}...`);
  const { pipeline: createPipeline } = await import(
    "@huggingface/transformers"
  );
  pipeline = (await createPipeline(
    "feature-extraction",
    modelName
  )) as unknown as Pipeline;
  logger.info("Embedding model loaded.");
  return pipeline;
}

/** Embed a single text, returns Float32Array of length 384 */
export async function embed(text: string): Promise<Float32Array> {
  const pipe = await getPipeline();
  const output = await pipe([text], { pooling: "mean", normalize: true });
  // output.data is the full flat buffer; extract first vector
  const dims = output.dims;
  const vecLen = dims[dims.length - 1];
  return new Float32Array(output.data.buffer, output.data.byteOffset, vecLen);
}

/** Batch-embed multiple texts, returns array of Float32Array (384-dim each) */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  const pipe = await getPipeline();
  const results: Float32Array[] = [];

  for (let i = 0; i < texts.length; i += SUB_BATCH_SIZE) {
    const batch = texts.slice(i, i + SUB_BATCH_SIZE);
    const output = await pipe(batch, { pooling: "mean", normalize: true });
    const dims = output.dims;
    const vecLen = dims[dims.length - 1];

    for (let j = 0; j < batch.length; j++) {
      // Each vector starts at offset j * vecLen in the flat buffer
      const start = j * vecLen;
      // .slice() creates a copy — safe to use independently
      const vec = output.data.slice(start, start + vecLen);
      results.push(vec);
    }

    if (texts.length > SUB_BATCH_SIZE) {
      logger.debug(
        `Embedded ${Math.min(i + SUB_BATCH_SIZE, texts.length)}/${texts.length} texts`
      );
    }
  }

  return results;
}
