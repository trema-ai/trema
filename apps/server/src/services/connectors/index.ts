export {
  loadProviderCatalog,
  type ProviderCatalog,
  ProviderCatalogValidationError,
} from "#/services/connectors/catalog.js";
export {
  type ProviderHook,
  type ProviderHookRegistry,
  providerHookRegistry,
} from "#/services/connectors/hooks.js";
export {
  githubProvider,
  linearProvider,
  notionMcpProvider,
  providerDefinitions,
} from "#/services/connectors/providers/index.js";
export {
  type AuthMode,
  type AuthRecipe,
  authModeSchema,
  authModes,
  authRecipeSchema,
  type FieldDescriptor,
  fieldDescriptorSchema,
  type McpTransport,
  mcpTransportSchema,
  type ProviderDef,
  type ProviderDefInput,
  type ProviderHooks,
  type ProviderTransport,
  providerDefSchema,
  providerHooksSchema,
  type RestTransport,
  restTransportSchema,
  type ToolDefinition,
  toolDefinitionSchema,
  transportSchema,
} from "#/services/connectors/schema.js";
export {
  extractPlaceholders,
  interpolate,
  TemplateInterpolationError,
  type TemplateValues,
} from "#/services/connectors/templates.js";
