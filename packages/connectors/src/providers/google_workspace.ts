import type { ProviderDefInput } from "#connectors/schema.js";

const gmailReadonly = "https://www.googleapis.com/auth/gmail.readonly";
const gmailCompose = "https://www.googleapis.com/auth/gmail.compose";
const gmailSend = "https://www.googleapis.com/auth/gmail.send";
const calendarReadonly = "https://www.googleapis.com/auth/calendar.readonly";
const calendarEvents = "https://www.googleapis.com/auth/calendar.events";
const driveReadonly = "https://www.googleapis.com/auth/drive.readonly";
const driveFile = "https://www.googleapis.com/auth/drive.file";

export const googleWorkspaceProvider = {
  key: "google_workspace",
  displayName: "Google Workspace",
  description:
    "A curated set of Gmail, Google Calendar, and Google Drive tools for a connected Google Workspace account.",
  logoUrl: "/connector-logos/google-workspace.svg",
  categories: ["productivity"],
  docsUrl: "https://developers.google.com/workspace",
  authMode: "oauth2_code",
  auth: {
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    refreshUrl: "https://oauth2.googleapis.com/token",
    authorizationParams: {
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
    },
    pkce: true,
    tokenRequestAuthMethod: "body",
    scopeSeparator: " ",
    defaultScopes: ["openid", "email", gmailReadonly, calendarReadonly, driveReadonly],
    availableScopes: [
      "openid",
      "email",
      gmailReadonly,
      calendarReadonly,
      driveReadonly,
      gmailCompose,
      gmailSend,
      calendarEvents,
      driveFile,
      "profile",
    ],
    // The post-connection hook supplies this from the id_token. It also
    // provides the connection label fallback without exposing raw config.
    tokenResponseMetadata: ["email"],
    accountIdentityFields: ["sub"],
  },
  configFields: {},
  credentialFields: {},
  transport: {
    type: "rest",
    baseUrl: "https://www.googleapis.com",
    // APIs.guru converts Google's discovery documents to OpenAPI. Gmail is
    // the provenance source for this manifest; Calendar and Drive operations
    // are documented alongside it in openapi-curations/google_workspace.yaml.
    openApiSpecUrl: "https://api.apis.guru/v2/specs/googleapis.com/gmail/v1/openapi.json",
    verification: { method: "GET", endpoints: ["/oauth2/v3/userinfo"] },
  },
  hooks: { postConnection: "google_id_token_identity" },
  toolManifest: [
    {
      name: "search_messages",
      description:
        "Search Gmail messages and return message ids plus threadIds; use get_message or get_thread for content. Required OAuth scope: https://www.googleapis.com/auth/gmail.readonly.",
      method: "GET",
      baseUrl: "https://gmail.googleapis.com",
      path: "/gmail/v1/users/me/messages",
      paramsSchema: {
        type: "object",
        properties: {
          q: { type: "string", description: "Gmail search query." },
          maxResults: { type: "integer", description: "Maximum results to return." },
          pageToken: { type: "string", description: "Page token from a previous response." },
        },
      },
      sensitivity: "read",
    },
    {
      name: "get_message",
      description:
        "Get one Gmail message by id; format defaults to metadata. Required OAuth scope: https://www.googleapis.com/auth/gmail.readonly.",
      method: "GET",
      baseUrl: "https://gmail.googleapis.com",
      path: "/gmail/v1/users/me/messages/{id}",
      paramsSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Gmail message id." },
          format: {
            type: "string",
            enum: ["minimal", "full", "raw", "metadata"],
            default: "metadata",
          },
        },
        required: ["id"],
      },
      sensitivity: "read",
    },
    {
      name: "get_thread",
      description:
        "Get one Gmail thread and its messages by id. Required OAuth scope: https://www.googleapis.com/auth/gmail.readonly.",
      method: "GET",
      baseUrl: "https://gmail.googleapis.com",
      path: "/gmail/v1/users/me/threads/{id}",
      paramsSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Gmail thread id." },
          format: { type: "string", enum: ["minimal", "full", "metadata"] },
        },
        required: ["id"],
      },
      sensitivity: "read",
    },
    {
      name: "list_labels",
      description:
        "List Gmail labels for the connected mailbox. Required OAuth scope: https://www.googleapis.com/auth/gmail.readonly.",
      method: "GET",
      baseUrl: "https://gmail.googleapis.com",
      path: "/gmail/v1/users/me/labels",
      paramsSchema: { type: "object", properties: {} },
      sensitivity: "read",
    },
    {
      name: "create_draft",
      description:
        "Create a Gmail draft with message.raw containing a base64url-encoded RFC 2822 message. Required OAuth scope: https://www.googleapis.com/auth/gmail.compose.",
      method: "POST",
      baseUrl: "https://gmail.googleapis.com",
      path: "/gmail/v1/users/me/drafts",
      paramsSchema: {
        type: "object",
        properties: {
          message: {
            type: "object",
            description: "Draft message with raw as a base64url-encoded RFC 2822 message.",
            properties: { raw: { type: "string" } },
            required: ["raw"],
          },
        },
        required: ["message"],
      },
      sensitivity: "write",
    },
    {
      name: "send_message",
      description:
        "Send a Gmail message with raw as a base64url-encoded RFC 2822 message. Required OAuth scope: https://www.googleapis.com/auth/gmail.send.",
      method: "POST",
      baseUrl: "https://gmail.googleapis.com",
      path: "/gmail/v1/users/me/messages/send",
      paramsSchema: {
        type: "object",
        properties: {
          raw: { type: "string", description: "Base64url-encoded RFC 2822 message." },
          threadId: { type: "string", description: "Optional Gmail thread id for a reply." },
        },
        required: ["raw"],
      },
      sensitivity: "write",
    },
    {
      name: "list_calendars",
      description:
        "List calendars available to the connected Google account. Required OAuth scope: https://www.googleapis.com/auth/calendar.readonly.",
      method: "GET",
      path: "/calendar/v3/users/me/calendarList",
      paramsSchema: { type: "object", properties: {} },
      sensitivity: "read",
    },
    {
      name: "list_events",
      description:
        "List events in a calendar, filterable by time range or text. Required OAuth scope: https://www.googleapis.com/auth/calendar.readonly.",
      method: "GET",
      path: "/calendar/v3/calendars/{calendarId}/events",
      paramsSchema: {
        type: "object",
        properties: {
          calendarId: { type: "string", description: "Calendar id, such as primary." },
          timeMin: { type: "string", description: "Lower RFC 3339 time bound." },
          timeMax: { type: "string", description: "Upper RFC 3339 time bound." },
          q: { type: "string", description: "Free-text search query." },
          singleEvents: { type: "boolean", description: "Expand recurring events into instances." },
          maxResults: { type: "integer", description: "Maximum events to return." },
        },
        required: ["calendarId"],
      },
      sensitivity: "read",
    },
    {
      name: "get_event",
      description:
        "Get one Google Calendar event by calendar and event id. Required OAuth scope: https://www.googleapis.com/auth/calendar.readonly.",
      method: "GET",
      path: "/calendar/v3/calendars/{calendarId}/events/{eventId}",
      paramsSchema: {
        type: "object",
        properties: {
          calendarId: { type: "string", description: "Calendar id, such as primary." },
          eventId: { type: "string", description: "Google Calendar event id." },
        },
        required: ["calendarId", "eventId"],
      },
      sensitivity: "read",
    },
    {
      name: "check_availability",
      description:
        "Check free and busy time across specified calendars. Required OAuth scope: https://www.googleapis.com/auth/calendar.readonly.",
      method: "POST",
      path: "/calendar/v3/freeBusy",
      paramsSchema: {
        type: "object",
        properties: {
          timeMin: { type: "string", description: "Lower RFC 3339 time bound." },
          timeMax: { type: "string", description: "Upper RFC 3339 time bound." },
          items: {
            type: "array",
            description: "Calendars to check, each as an object with an id.",
            items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
          },
        },
        required: ["timeMin", "timeMax", "items"],
      },
      sensitivity: "read",
    },
    {
      name: "create_event",
      description:
        "Create a Google Calendar event in a calendar. Required OAuth scope: https://www.googleapis.com/auth/calendar.events.",
      method: "POST",
      path: "/calendar/v3/calendars/{calendarId}/events",
      paramsSchema: {
        type: "object",
        properties: {
          calendarId: { type: "string", description: "Calendar id, such as primary." },
          summary: { type: "string", description: "Event title." },
          start: { type: "object", description: "Start time, for example dateTime and timeZone." },
          end: { type: "object", description: "End time, for example dateTime and timeZone." },
          attendees: {
            type: "array",
            items: { type: "object" },
            description: "Optional attendees.",
          },
        },
        required: ["calendarId", "summary", "start", "end"],
      },
      sensitivity: "write",
    },
    {
      name: "update_event",
      description:
        "Update fields on a Google Calendar event. Required OAuth scope: https://www.googleapis.com/auth/calendar.events.",
      method: "PATCH",
      path: "/calendar/v3/calendars/{calendarId}/events/{eventId}",
      paramsSchema: {
        type: "object",
        properties: {
          calendarId: { type: "string", description: "Calendar id, such as primary." },
          eventId: { type: "string", description: "Google Calendar event id." },
          summary: { type: "string", description: "Replacement event title." },
          start: { type: "object", description: "Replacement start time." },
          end: { type: "object", description: "Replacement end time." },
          attendees: {
            type: "array",
            items: { type: "object" },
            description: "Replacement attendees.",
          },
        },
        required: ["calendarId", "eventId"],
      },
      sensitivity: "write",
    },
    {
      name: "delete_event",
      description:
        "Delete a Google Calendar event. Required OAuth scope: https://www.googleapis.com/auth/calendar.events.",
      method: "DELETE",
      path: "/calendar/v3/calendars/{calendarId}/events/{eventId}",
      paramsSchema: {
        type: "object",
        properties: {
          calendarId: { type: "string", description: "Calendar id, such as primary." },
          eventId: { type: "string", description: "Google Calendar event id." },
        },
        required: ["calendarId", "eventId"],
      },
      sensitivity: "destructive",
    },
    {
      name: "search_files",
      description:
        "Search Google Drive files with Drive query syntax, for example name contains 'roadmap'. Required OAuth scope: https://www.googleapis.com/auth/drive.readonly.",
      method: "GET",
      path: "/drive/v3/files",
      paramsSchema: {
        type: "object",
        properties: {
          q: { type: "string", description: "Drive query syntax." },
          pageSize: { type: "integer", description: "Maximum files to return." },
          fields: { type: "string", description: "Partial-response field selector." },
        },
      },
      sensitivity: "read",
    },
    {
      name: "get_file_metadata",
      description:
        "Get metadata for a Google Drive file. Required OAuth scope: https://www.googleapis.com/auth/drive.readonly.",
      method: "GET",
      path: "/drive/v3/files/{fileId}",
      paramsSchema: {
        type: "object",
        properties: {
          fileId: { type: "string", description: "Google Drive file id." },
          fields: { type: "string", description: "Partial-response field selector." },
        },
        required: ["fileId"],
      },
      sensitivity: "read",
    },
    {
      name: "export_file",
      description:
        "Export a Google Workspace file as text/plain, text/csv, or application/pdf. Required OAuth scope: https://www.googleapis.com/auth/drive.readonly.",
      method: "GET",
      path: "/drive/v3/files/{fileId}/export",
      paramsSchema: {
        type: "object",
        properties: {
          fileId: { type: "string", description: "Google Drive file id." },
          mimeType: {
            type: "string",
            description: "Export MIME type, such as text/plain, text/csv, or application/pdf.",
          },
        },
        required: ["fileId", "mimeType"],
      },
      sensitivity: "read",
    },
  ],
  memberConnectable: true,
} satisfies ProviderDefInput;
