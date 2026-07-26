import anthropicIcon from "@lobehub/icons-static-svg/icons/anthropic.svg";
import azureIcon from "@lobehub/icons-static-svg/icons/azure-color.svg";
import cohereIcon from "@lobehub/icons-static-svg/icons/cohere-color.svg";
import deepseekIcon from "@lobehub/icons-static-svg/icons/deepseek-color.svg";
import fireworksIcon from "@lobehub/icons-static-svg/icons/fireworks-color.svg";
import geminiIcon from "@lobehub/icons-static-svg/icons/gemini-color.svg";
import googleIcon from "@lobehub/icons-static-svg/icons/google-color.svg";
import groqIcon from "@lobehub/icons-static-svg/icons/groq.svg";
import lmstudioIcon from "@lobehub/icons-static-svg/icons/lmstudio.svg";
import mistralIcon from "@lobehub/icons-static-svg/icons/mistral-color.svg";
import ollamaIcon from "@lobehub/icons-static-svg/icons/ollama.svg";
import openaiIcon from "@lobehub/icons-static-svg/icons/openai.svg";
import openrouterIcon from "@lobehub/icons-static-svg/icons/openrouter-color.svg";
import perplexityIcon from "@lobehub/icons-static-svg/icons/perplexity-color.svg";
import togetherIcon from "@lobehub/icons-static-svg/icons/together-color.svg";
import vllmIcon from "@lobehub/icons-static-svg/icons/vllm-color.svg";
import xaiIcon from "@lobehub/icons-static-svg/icons/xai.svg";

/**
 * Brand marks, keyed by the slug a preset or a provider name resolves to. Each
 * one is imported so the build carries it: a self-hosted deployment must not
 * reach a CDN to draw a logo, and an air-gapped one could not.
 */
const brandIcons: Record<string, string> = {
  anthropic: anthropicIcon,
  azure: azureIcon,
  cohere: cohereIcon,
  deepseek: deepseekIcon,
  fireworks: fireworksIcon,
  gemini: geminiIcon,
  google: googleIcon,
  groq: groqIcon,
  lmstudio: lmstudioIcon,
  mistral: mistralIcon,
  ollama: ollamaIcon,
  openai: openaiIcon,
  openrouter: openrouterIcon,
  perplexity: perplexityIcon,
  together: togetherIcon,
  vllm: vllmIcon,
  xai: xaiIcon,
};

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Vendors whose domain does not carry the icon key as a label of its own.
 * Matched against the end of the host, so a subdomain of one still counts.
 */
const hostAliases: Record<string, string> = {
  "x.ai": "xai",
  "googleapis.com": "google",
};

/**
 * The vendor a base URL belongs to, when its host says so outright. Whole
 * labels only: a substring test puts xAI's mark on relaxai.io and Google's on
 * a corporate proxy called my-google-proxy, and a wrong trademark beside an
 * unrelated endpoint is worse than the neutral tile.
 */
function iconFromHost(baseUrl: string | undefined) {
  if (!baseUrl) return undefined;
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  for (const [domain, key] of Object.entries(hostAliases)) {
    if (host === domain || host.endsWith(`.${domain}`)) return brandIcons[key];
  }
  for (const label of host.split(".")) {
    // Object.hasOwn: a host label like "constructor" must not reach the prototype.
    if (Object.hasOwn(brandIcons, label)) return brandIcons[label];
  }
  return undefined;
}

/**
 * The mark for a provider, chosen from what the caller knows: the preset's own
 * icon first, then the name and label an admin typed — so a custom provider
 * called "Anthropic" gets the logo — then the host it points at.
 */
export function providerIcon(input: {
  icon?: string | undefined;
  name?: string | undefined;
  label?: string | undefined;
  baseUrl?: string | undefined;
}) {
  for (const candidate of [input.icon, input.name, input.label]) {
    if (!candidate) continue;
    const key = slug(candidate);
    // Object.hasOwn: a provider named "constructor" must not reach the prototype.
    if (Object.hasOwn(brandIcons, key)) return brandIcons[key];
  }
  return iconFromHost(input.baseUrl);
}

export function ProviderLogo({
  icon,
  name,
  label,
  baseUrl,
  className = "size-9",
}: {
  icon?: string | undefined;
  name?: string | undefined;
  label?: string | undefined;
  baseUrl?: string | undefined;
  className?: string;
}) {
  const source = providerIcon({ icon, name, label, baseUrl });
  const initial = (label ?? name ?? "?").trim().slice(0, 1).toUpperCase();
  // Marks are drawn on white in both themes: several are monochrome black, and
  // a brand mark is not ours to recolor.
  return source ? (
    <img
      src={source}
      alt=""
      className={`${className} shrink-0 rounded-md border bg-white object-contain p-1.5`}
    />
  ) : (
    <div
      className={`${className} grid shrink-0 place-items-center rounded-md border bg-muted font-medium`}
      aria-hidden="true"
    >
      {initial}
    </div>
  );
}
