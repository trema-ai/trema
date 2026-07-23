export interface TemplateValues {
  config?: Readonly<Record<string, string | number | boolean>>;
  credentials?: Readonly<Record<string, string | number | boolean>>;
  clientId?: string;
}

const placeholderPattern = /\$\{([^{}]+)\}/g;

export class TemplateInterpolationError extends Error {
  readonly placeholders: readonly string[];

  constructor(template: string, placeholders: readonly string[]) {
    super(`Template has unfilled placeholders: ${placeholders.join(", ")} (${template})`);
    this.name = "TemplateInterpolationError";
    this.placeholders = placeholders;
  }
}

export function extractPlaceholders(template: string): string[] {
  return Array.from(template.matchAll(placeholderPattern), (match) => match[1] ?? "");
}

function resolvePlaceholder(reference: string, values: TemplateValues): string | undefined {
  if (reference === "clientId") return values.clientId;

  const match = /^(config|credentials)\.([A-Za-z0-9_]+)$/.exec(reference);
  if (!match) return undefined;

  const [, root, key] = match;
  const value = root === "config" ? values.config?.[key ?? ""] : values.credentials?.[key ?? ""];
  return value === undefined ? undefined : String(value);
}

export function interpolate(template: string, values: TemplateValues): string {
  const unfilled: string[] = [];
  const interpolated = template.replace(placeholderPattern, (_, reference: string) => {
    const value = resolvePlaceholder(reference, values);
    if (value === undefined) {
      unfilled.push(reference);
      return `\${${reference}}`;
    }
    return value;
  });

  if (interpolated.includes("${")) {
    if (unfilled.length === 0) unfilled.push("malformed placeholder");
    throw new TemplateInterpolationError(template, unfilled);
  }

  return interpolated;
}
