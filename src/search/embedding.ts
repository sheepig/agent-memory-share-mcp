import type { FeatureExtractionPipeline, PreTrainedTokenizer, Tensor } from "@huggingface/transformers";

import type { ContentTokenCounter } from "../sources/session-turns.js";

const EMBEDDING_MODEL_REPOSITORY = "jinaai/jina-embeddings-v2-base-zh";
const EMBEDDING_MODEL_REVISION = "c1ff9086a89a1123d7b5eff58055a665db4fb4b9";
// Capacity of the pinned model config; its tokenizer config defaults to only 512.
const EMBEDDING_MAX_INPUT_TOKENS = 8_192;
const EMBEDDING_INPUT_VERSION = 4;
export const DEFAULT_EMBEDDING_MODEL = `${EMBEDDING_MODEL_REPOSITORY}@${EMBEDDING_MODEL_REVISION}#input-v${EMBEDDING_INPUT_VERSION}`;

export interface EmbeddingProvider extends ContentTokenCounter {
  readonly modelId: string;
  embedPassages(texts: readonly string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
  dispose?(): Promise<void>;
}

function rows(tensor: Tensor): Float32Array[] {
  const values = tensor.tolist() as number[][];
  return values.map((value) => Float32Array.from(value));
}

export class LocalContentTokenizer implements ContentTokenCounter {
  private tokenizer?: Promise<PreTrainedTokenizer>;

  constructor(protected readonly cacheDirectory: string) {}

  async countContentTokens(text: string): Promise<number> {
    if (!text) return 0;
    const tokenizer = await this.getTokenizer();
    const encoded = tokenizer(text, {
      add_special_tokens: false,
      padding: false,
      truncation: false,
    });
    return (encoded.input_ids as Tensor).dims.at(-1) ?? 0;
  }

  protected async validateModelInputs(texts: readonly string[]): Promise<void> {
    const tokenizer = await this.getTokenizer();
    for (const text of texts) {
      const encoded = tokenizer(text, { add_special_tokens: true, padding: false, truncation: false });
      const tokens = (encoded.input_ids as Tensor).dims.at(-1) ?? 0;
      if (tokens > EMBEDDING_MAX_INPUT_TOKENS) {
        throw new Error(`Embedding input has ${tokens} tokens; model capacity is ${EMBEDDING_MAX_INPUT_TOKENS}.`);
      }
    }
  }

  private getTokenizer(): Promise<PreTrainedTokenizer> {
    this.tokenizer ??= import("@huggingface/transformers").then(({ AutoTokenizer }) => AutoTokenizer.from_pretrained(
      EMBEDDING_MODEL_REPOSITORY,
      { cache_dir: this.cacheDirectory, revision: EMBEDDING_MODEL_REVISION },
    )).catch((error: unknown) => { this.tokenizer = undefined; throw error; });
    return this.tokenizer;
  }
}

export class LocalEmbeddingProvider extends LocalContentTokenizer implements EmbeddingProvider {
  readonly modelId = DEFAULT_EMBEDDING_MODEL;
  private extractor?: Promise<FeatureExtractionPipeline>;

  async embedPassages(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    return this.embed([...texts]);
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [embedding] = await this.embed([text]);
    if (!embedding) throw new Error("The embedding model returned no query vector.");
    return embedding;
  }

  async dispose(): Promise<void> {
    const extractor = this.extractor;
    this.extractor = undefined;
    if (extractor) await extractor.then((loaded) => loaded.dispose(), () => undefined);
  }

  private async embed(texts: string[]): Promise<Float32Array[]> {
    await this.validateModelInputs(texts);
    const extractor = await this.getExtractor();
    const output = await extractor(texts, { normalize: true, pooling: "mean" });
    return rows(output);
  }

  private getExtractor(): Promise<FeatureExtractionPipeline> {
    this.extractor ??= import("@huggingface/transformers").then(({ pipeline }) => pipeline(
      "feature-extraction",
      EMBEDDING_MODEL_REPOSITORY,
      { cache_dir: this.cacheDirectory, dtype: "q8", revision: EMBEDDING_MODEL_REVISION },
    )).then((extractor) => {
      extractor.tokenizer.config.model_max_length = EMBEDDING_MAX_INPUT_TOKENS;
      return extractor;
    }).catch((error: unknown) => { this.extractor = undefined; throw error; });
    return this.extractor;
  }
}

export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length === 0 || left.length !== right.length) return Number.NEGATIVE_INFINITY;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) return Number.NEGATIVE_INFINITY;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

export function decodeEmbedding(value: Buffer): Float32Array {
  if (value.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error("Stored embedding has an invalid byte length.");
  }
  return new Float32Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
}

export function encodeEmbedding(value: Float32Array): Buffer {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}
