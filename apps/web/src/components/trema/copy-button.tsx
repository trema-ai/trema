import { Check, Copy } from "lucide-react";
import * as React from "react";

import { Button } from "#/components/ui/button.tsx";
import { cn } from "#/lib/utils.ts";

type CopyButtonProps = Omit<React.ComponentProps<typeof Button>, "children" | "onClick"> & {
  value: string;
};

function CopyButton({ value, className, ...props }: CopyButtonProps) {
  const [copied, setCopied] = React.useState(false);
  const timeoutRef = React.useRef<number | undefined>(undefined);

  React.useEffect(() => {
    return () => {
      if (timeoutRef.current !== undefined) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const handleCopy = () => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      if (timeoutRef.current !== undefined) {
        window.clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <Button
      data-slot="copy-button"
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={copied ? "Copied" : "Copy"}
      onClick={handleCopy}
      className={cn("text-muted-foreground", className)}
      {...props}
    >
      {copied ? <Check className="text-go" /> : <Copy />}
    </Button>
  );
}

export { CopyButton, type CopyButtonProps };
