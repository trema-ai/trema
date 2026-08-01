export interface ModelSelection {
  providerName: string;
  modelId: string;
}

export function modelSelectionValue(model: ModelSelection): string {
  return JSON.stringify([model.providerName, model.modelId]);
}
