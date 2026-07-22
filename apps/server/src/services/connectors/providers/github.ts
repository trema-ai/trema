import type { ProviderDefInput } from "#/services/connectors/schema.js";

export const githubProvider = {
  key: "github",
  displayName: "GitHub",
  categories: ["developer-tools"],
  docsUrl: "https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps",
  authMode: "oauth2_code",
  auth: {
    authorizationUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    defaultScopes: ["read:user", "repo"],
    // GitHub OAuth apps do not support PKCE.
    pkce: false,
  },
  configFields: {},
  credentialFields: {},
  transport: {
    type: "rest",
    baseUrl: "https://api.github.com",
    verification: { method: "GET", endpoints: ["/user"] },
  },
  toolManifest: [
    {
      name: "search_issues",
      description: "Search issues and pull requests visible to the connected GitHub account.",
      method: "GET",
      path: "/search/issues",
      paramsSchema: {
        type: "object",
        properties: { q: { type: "string" } },
        required: ["q"],
      },
      sensitivity: "read",
    },
    {
      name: "get_issue",
      description: "Get one issue from a GitHub repository.",
      method: "GET",
      path: "/repos/{owner}/{repo}/issues/{issueNumber}",
      paramsSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          issueNumber: { type: "integer" },
        },
        required: ["owner", "repo", "issueNumber"],
      },
      sensitivity: "read",
    },
    {
      name: "create_issue_comment",
      description: "Add a comment to an issue or pull request in a GitHub repository.",
      method: "POST",
      path: "/repos/{owner}/{repo}/issues/{issueNumber}/comments",
      paramsSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          issueNumber: { type: "integer" },
          body: { type: "string" },
        },
        required: ["owner", "repo", "issueNumber", "body"],
      },
      sensitivity: "write",
    },
    {
      name: "get_pull_request",
      description: "Get one pull request from a GitHub repository.",
      method: "GET",
      path: "/repos/{owner}/{repo}/pulls/{pullNumber}",
      paramsSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          pullNumber: { type: "integer" },
        },
        required: ["owner", "repo", "pullNumber"],
      },
      sensitivity: "read",
    },
  ],
  memberConnectable: true,
} satisfies ProviderDefInput;
