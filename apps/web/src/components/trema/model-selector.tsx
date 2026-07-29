import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useState } from "react";

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
import { cn } from "#web/lib/utils.ts";

export interface ModelOption {
  id: string;
  name: string;
  description?: string;
  keywords?: readonly string[];
}

export interface ModelSelectorProps {
  models: readonly ModelOption[];
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
}

/**
 * Searchable model picker for the composer. It is deliberately controlled:
 * persistence and offered-list fallback belong to the chat preference store.
 */
export function ModelSelector({ models, value, onValueChange, className }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const selected = models.find((model) => model.id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label="Model"
          className={cn(
            "h-7 max-w-64 gap-1.5 rounded-full px-2.5 font-normal text-(length:--text-chrome) text-muted-foreground hover:text-foreground",
            className,
          )}
        >
          <span className="truncate font-medium">{selected?.name ?? "Select model"}</span>
          <ChevronDownIcon className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-72 overflow-hidden rounded-xl border-border/70 bg-popover/95 p-0 shadow-overlay backdrop-blur-sm"
      >
        <Command
          defaultValue={value}
          filter={(_itemValue, search, keywords) =>
            (keywords ?? []).join(" ").toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0
          }
        >
          <CommandInput placeholder="Search models…" className="text-(length:--text-chrome)" />
          <CommandList className="[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <CommandEmpty>No models found.</CommandEmpty>
            <CommandGroup>
              {models.map((model) => (
                <CommandItem
                  key={model.id}
                  value={model.id}
                  keywords={[model.name, model.id, ...(model.keywords ?? [])]}
                  onSelect={() => {
                    onValueChange(model.id);
                    setOpen(false);
                  }}
                  className="relative gap-2 rounded-sm py-2 pr-9 pl-3 text-(length:--text-chrome)"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{model.name}</span>
                    {model.description === undefined ? null : (
                      <span className="truncate text-meta text-muted-foreground">
                        {model.description}
                      </span>
                    )}
                  </span>
                  {model.id === value ? <CheckIcon className="absolute right-3 size-3.5" /> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
