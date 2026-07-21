import { MessagePartPrimitive, MessagePrimitive } from "@assistant-ui/react";

function UserText() {
  return (
    <p className="text-chat break-words whitespace-pre-wrap">
      <MessagePartPrimitive.Text />
    </p>
  );
}

/* User messages sit in a right-aligned muted bubble with a tail corner. */
function UserMessage() {
  return (
    <MessagePrimitive.Root data-slot="user-message" className="flex w-full justify-end">
      <div className="max-w-[80%] rounded-2xl rounded-br-md bg-muted px-4 py-2.5">
        <MessagePrimitive.Parts components={{ Text: UserText }} />
      </div>
    </MessagePrimitive.Root>
  );
}

export { UserMessage };
