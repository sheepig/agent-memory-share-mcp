import type { PreTrainedModel, PreTrainedTokenizer, Tensor } from "@huggingface/transformers";
import fs from "node:fs/promises";
import path from "node:path";

const MODEL_REPOSITORY = "onnx-community/bge-reranker-v2-m3-ONNX";
const MODEL_REVISION = "6f5ff65298512715a1e669753bc754d2bc8f367b";
export const RERANKER_MAX_INPUT_TOKENS = 8_192;
export const RERANKER_THREADS = 4;
export const DEFAULT_RERANKER_MODEL = `${MODEL_REPOSITORY}@${MODEL_REVISION}#q8-pair-v1`;

export interface RerankerProvider {
  readonly modelId: string;
  score(query: string, documents: readonly string[]): Promise<number[]>;
}

/** Pointwise cross-encoder scores are raw logits, not calibrated probabilities. */
export class LocalRerankerProvider implements RerankerProvider {
  readonly modelId = DEFAULT_RERANKER_MODEL;
  private runtime?: Promise<{ model: PreTrainedModel; tokenizer: PreTrainedTokenizer }>;

  constructor(private readonly cacheDirectory: string) {}

  async score(query: string, documents: readonly string[]): Promise<number[]> {
    if (!query.trim()) throw new Error("Reranker query must not be empty.");
    if (documents.length === 0) return [];
    const { model, tokenizer } = await this.getRuntime();
    const scores: number[] = [];
    // One pair at a time bounds padding and attention memory for long Session turns.
    for (const document of documents) {
      const inputs = tokenizer(query, { text_pair: document, padding: false, truncation: false });
      const tokens = (inputs.input_ids as Tensor).dims.at(-1) ?? 0;
      if (tokens > RERANKER_MAX_INPUT_TOKENS) {
        throw new Error(`Reranker pair has ${tokens} tokens; model capacity is ${RERANKER_MAX_INPUT_TOKENS}.`);
      }
      const { logits } = await model(inputs) as { logits: Tensor };
      const score = Number(logits.data[0]);
      if (logits.dims.reduce((size, dim) => size * dim, 1) !== 1 || !Number.isFinite(score)) {
        throw new Error("Reranker must return one finite score per query/document pair.");
      }
      scores.push(score);
    }
    return scores;
  }

  async dispose(): Promise<void> {
    if (!this.runtime) return;
    const { model } = await this.runtime;
    await model.dispose();
    this.runtime = undefined;
  }

  private getRuntime() {
    this.runtime ??= import("@huggingface/transformers").then(async ({ AutoModelForSequenceClassification, AutoTokenizer }) => {
      const options = { cache_dir: this.cacheDirectory, revision: MODEL_REVISION };
      const localModel = path.resolve(this.cacheDirectory, MODEL_REPOSITORY, MODEL_REVISION);
      let modelPath = MODEL_REPOSITORY;
      try {
        await fs.access(path.join(localModel, "tokenizer.json"));
        await fs.access(path.join(localModel, "onnx", "model_quantized.onnx"));
        modelPath = localModel;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      // Transformers.js tokenizer file discovery otherwise probes the Hub's main revision,
      // even when the pinned files already exist in a custom cache directory.
      const tokenizer = await AutoTokenizer.from_pretrained(modelPath, options);
      const model = await AutoModelForSequenceClassification.from_pretrained(modelPath, {
        ...options,
        device: "cpu",
        dtype: "q8",
        session_options: { intraOpNumThreads: RERANKER_THREADS, interOpNumThreads: 1 },
      });
      return { model, tokenizer };
    });
    return this.runtime;
  }
}
