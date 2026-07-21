import type { ToolDef } from "@trema/harness";
import type {
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
  ProviderMetadata,
  TextStreamPart,
  ToolSet,
} from "ai";
import { generateText, jsonSchema, streamText, tool } from "ai";

export interface SdkCallOptions {
  model: LanguageModel;
  messages: ModelMessage[];
  abortSignal: AbortSignal;
  maxOutputTokens?: number;
  providerOptions?: SdkProviderOptions;
  tools?: ToolSet;
  toolOrder?: string[];
}

export type SdkProviderOptions = NonNullable<Parameters<typeof streamText>[0]["providerOptions"]>;

export interface SdkStreamResult {
  fullStream: AsyncIterable<TextStreamPart<ToolSet>>;
}

export interface SdkGenerateResult {
  text: string;
  usage: LanguageModelUsage;
  providerMetadata?: ProviderMetadata;
}

export interface SdkOperations {
  stream(options: SdkCallOptions): SdkStreamResult;
  generate(options: SdkCallOptions): Promise<SdkGenerateResult>;
}

export function toSdkTools(definitions: readonly ToolDef[]): {
  tools?: ToolSet;
  toolOrder?: string[];
} {
  if (definitions.length === 0) return {};
  const names = definitions.map((definition) => definition.name);
  if (new Set(names).size !== names.length) throw new Error("Tool names must be unique");

  const tools: ToolSet = {};
  for (const definition of definitions) {
    tools[definition.name] = tool({
      description: definition.description,
      inputSchema: jsonSchema(definition.schema as never),
    });
  }
  return { tools, toolOrder: names };
}

export const defaultSdkOperations: SdkOperations = {
  stream(options) {
    return streamText({ ...options, allowSystemInMessages: true, maxRetries: 0 });
  },
  async generate(options) {
    const result = await generateText({ ...options, allowSystemInMessages: true, maxRetries: 0 });
    const providerMetadata = result.finalStep.providerMetadata;
    return {
      text: result.text,
      usage: result.usage,
      ...(providerMetadata === undefined ? {} : { providerMetadata }),
    };
  },
};
