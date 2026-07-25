import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import { Button } from "#web/components/ui/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "#web/components/ui/tooltip.tsx";

/*
 * Ghost icon button that flips between light and dark. The icons swap
 * through the `dark:` variant so the button never renders stale during
 * the first paint.
 */
function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const next = resolvedTheme === "dark" ? "light" : "dark";

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Switch to ${next} theme`}
            onClick={() => setTheme(next)}
          >
            <Sun className="size-4 dark:hidden" />
            <Moon className="hidden size-4 dark:block" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Switch to {next} theme</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export { ThemeToggle };
