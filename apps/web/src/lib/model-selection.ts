export interface ModelSelection {
  providerName: string;
  modelId: string;
}

export interface OfferedModel {
  providerName: string;
  modelId: string;
}

const STORAGE_KEY = "trema.chat.model";
let loaded = false;
let selection: ModelSelection | undefined;
const listeners = new Set<() => void>();

function isSelection(value: unknown): value is ModelSelection {
  return (
    typeof value === "object" &&
    value !== null &&
    "providerName" in value &&
    typeof value.providerName === "string" &&
    value.providerName.trim() !== "" &&
    "modelId" in value &&
    typeof value.modelId === "string" &&
    value.modelId.trim() !== ""
  );
}

function readStoredSelection(): ModelSelection | undefined {
  if (typeof localStorage === "undefined") return undefined;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(stored);
    return isSelection(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  selection = readStoredSelection();
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function modelSelectionValue(model: ModelSelection): string {
  return JSON.stringify([model.providerName, model.modelId]);
}

export function resolveModelSelection(
  stored: ModelSelection | undefined,
  offered: readonly OfferedModel[],
): ModelSelection | undefined {
  if (stored === undefined) return undefined;
  return offered.some(
    (model) => model.providerName === stored.providerName && model.modelId === stored.modelId,
  )
    ? stored
    : undefined;
}

export function subscribeModelSelection(listener: () => void): () => void {
  ensureLoaded();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function modelSelectionSnapshot(): ModelSelection | undefined {
  ensureLoaded();
  return selection;
}

export function setModelSelection(next: ModelSelection | undefined): void {
  ensureLoaded();
  selection = next;
  if (typeof localStorage !== "undefined") {
    if (next === undefined) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }
  emit();
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    loaded = true;
    selection = readStoredSelection();
    emit();
  });
}
