import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { Badge } from "#web/components/ui/badge.tsx";
import { Button } from "#web/components/ui/button.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "#web/components/ui/command.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "#web/components/ui/popover.tsx";
import { fuzzyMatch } from "#web/lib/fuzzy.ts";
import { cn } from "#web/lib/utils.ts";

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  description?: string;
  keywords?: readonly string[];
}

export interface ModelSelectorProps {
  models: readonly ModelOption[];
  value: string;
  onValueChange: (value: string) => void;
  ariaLabel?: string;
  disabled?: boolean;
  emptyMessage?: string;
  placeholder?: string;
  selectedLabel?: string;
  variant?: "composer" | "settings";
  className?: string;
}

/**
 * Shared searchable model picker. It is deliberately controlled: persistence,
 * fallback, and any side effects belong to the screen that owns the selection.
 */
export function ModelSelector({
  models,
  value,
  onValueChange,
  ariaLabel = "Model",
  disabled = false,
  emptyMessage = "No models found.",
  placeholder = "Select model",
  selectedLabel,
  variant = "composer",
  className,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const selected = models.find((model) => model.id === value);
  const settings = variant === "settings";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={settings ? "outline" : "ghost"}
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn(
            settings
              ? "w-64 max-w-full justify-between font-normal"
              : "h-7 max-w-64 gap-1.5 rounded-full px-2.5 font-normal text-(length:--text-chrome) text-muted-foreground hover:text-foreground",
            className,
          )}
        >
          <span className={cn("truncate", !settings && "font-medium")}>
            {selectedLabel ?? selected?.name ?? placeholder}
          </span>
          <ChevronDownIcon className={cn("opacity-60", settings ? "size-4" : "size-3.5")} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align={settings ? "start" : "end"}
        sideOffset={6}
        className={cn(
          "overflow-hidden p-0",
          settings
            ? "w-(--radix-popover-trigger-width)"
            : "w-72 rounded-xl border-border/70 bg-popover/95 shadow-overlay backdrop-blur-sm",
        )}
      >
        <Command
          defaultValue={value}
          filter={(_itemValue, search, keywords) =>
            search.trim() === "" ? 1 : (fuzzyMatch(search, keywords ?? []) ?? 0)
          }
        >
          <CommandInput
            placeholder="Search models…"
            className={cn(!settings && "text-(length:--text-chrome)")}
          />
          <CommandList className="[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            <CommandGroup>
              {models.map((model) => (
                <CommandItem
                  key={model.id}
                  value={model.id}
                  keywords={[model.name, model.id, model.provider, ...(model.keywords ?? [])]}
                  onSelect={() => {
                    onValueChange(model.id);
                    setOpen(false);
                  }}
                  className={cn(
                    "relative gap-2 rounded-sm",
                    !settings && "py-2 pl-3 text-(length:--text-chrome)",
                  )}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{model.name}</span>
                    {model.description === undefined ? null : (
                      <span className="truncate text-meta text-muted-foreground">
                        {model.description}
                      </span>
                    )}
                  </span>
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    {model.id === value ? <CheckIcon className="size-3.5" /> : null}
                    <Badge
                      variant="outline"
                      title={model.provider}
                      className="max-w-24 px-1.5 py-0 text-[10px] leading-4 font-normal text-muted-foreground"
                    >
                      <span className="truncate">{model.provider}</span>
                    </Badge>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
