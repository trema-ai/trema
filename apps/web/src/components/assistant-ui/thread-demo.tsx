import {
  AssistantRuntimeProvider,
  type ChatModelAdapter,
  type ThreadMessageLike,
  useLocalRuntime,
} from "@assistant-ui/react";

import { Thread } from "#web/components/assistant-ui/thread.tsx";

/*
 * Self-contained chat demo for the gallery: mounts the Thread with a
 * local runtime whose adapter streams back a canned markdown response.
 * No network access is involved.
 */

const markdownTour = `## What I can render

Replies are markdown, so structure comes for free:

- **Bold**, *italic*, and \`inline code\`
- [Links](https://example.com) in the accent color
- Nested lists
  1. First step
  2. Second step

> Blockquotes get a left border and muted text.

\`\`\`ts
function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
\`\`\`

That covers the basics.`;

const markdownTable = `Here is a small comparison table:

| Feature | Status | Notes |
| --- | --- | --- |
| Streaming | Done | Token by token |
| Tables | Done | GitHub-flavored markdown |
| Attachments | Planned | Adapter not wired up yet |

---

Anything else you want to see?`;

const cannedReply = `Sure, here is a **streamed** reply.

It arrives a few words at a time, with a list:

- Streaming works without a backend
- The stop button cancels mid-reply
- \`inline code\` renders while streaming

\`\`\`sh
echo "done"
\`\`\``;

const initialMessages: readonly ThreadMessageLike[] = [
  { role: "user", content: "What can you render in a reply?" },
  { role: "assistant", content: markdownTour },
  { role: "user", content: "Nice, show me a table too." },
  { role: "assistant", content: markdownTable },
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/* Streams the canned reply back a few words at a time. */
const cannedAdapter: ChatModelAdapter = {
  async *run({ abortSignal }) {
    await sleep(400);
    const chunks = cannedReply.split(/(?<=\s)/);
    let text = "";
    for (const chunk of chunks) {
      if (abortSignal.aborted) return;
      await sleep(30);
      text += chunk;
      yield { content: [{ type: "text", text }] };
    }
  },
};

function ThreadDemo() {
  const runtime = useLocalRuntime(cannedAdapter, { initialMessages });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="h-[640px] overflow-hidden rounded-lg border bg-card">
        <Thread />
      </div>
    </AssistantRuntimeProvider>
  );
}

export { ThreadDemo };
