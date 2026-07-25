import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Button } from "#web/components/ui/button.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "#web/components/ui/command.tsx";
import { Input } from "#web/components/ui/input.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "#web/components/ui/popover.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#web/components/ui/select.tsx";
import { cn } from "#web/lib/utils.ts";

type FilterBarProps = {
  children: ReactNode;
  className?: string;
};

function FilterBar({ children, className }: FilterBarProps) {
  return (
    <div data-slot="filter-bar" className={cn("flex flex-wrap items-center gap-2", className)}>
      {children}
    </div>
  );
}

type FilterOption = {
  value: string;
  label: string;
};

type FilterSelectProps = {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  /* Include the "All ..." entry in the options; allValue marks it. */
  options: FilterOption[];
  allValue?: string;
};

function FilterSelect({
  label,
  value,
  onValueChange,
  options,
  allValue = "all",
}: FilterSelectProps) {
  const active = value !== allValue;

  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger
        size="sm"
        aria-label={label}
        data-slot="filter-select"
        className={cn(
          "h-8 gap-1.5 rounded-md border bg-card px-2.5 text-(length:--text-chrome) shadow-none dark:bg-card dark:hover:bg-card",
          active &&
            "border-moss/40 bg-moss-soft text-foreground dark:bg-moss-soft dark:hover:bg-moss-soft",
        )}
      >
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent align="start" position="popper">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

type FilterComboboxProps = FilterSelectProps & {
  searchPlaceholder?: string;
  emptyLabel?: string;
};

/* The searchable counterpart of FilterSelect, for option lists too long to scan. */
function FilterCombobox({
  label,
  value,
  onValueChange,
  options,
  allValue = "all",
  searchPlaceholder,
  emptyLabel = "No matches",
}: FilterComboboxProps) {
  const [open, setOpen] = useState(false);
  const active = value !== allValue;
  const selected = options.find((option) => option.value === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label={label}
          data-slot="filter-combobox"
          className={cn(
            "max-w-64 justify-between border bg-card px-2.5 font-normal text-(length:--text-chrome) shadow-none hover:bg-card dark:bg-card dark:hover:bg-card",
            active &&
              "border-moss/40 bg-moss-soft text-foreground hover:bg-moss-soft dark:bg-moss-soft dark:hover:bg-moss-soft",
          )}
        >
          <span className="truncate">{selected?.label ?? label}</span>
          <ChevronDownIcon className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command
          filter={(_itemValue, search, keywords) =>
            (keywords ?? []).join(" ").toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0
          }
        >
          <CommandInput
            placeholder={searchPlaceholder ?? `Search ${label.toLowerCase()}…`}
            className="text-(length:--text-chrome)"
          />
          <CommandList>
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  keywords={[option.label]}
                  className="text-(length:--text-chrome)"
                  onSelect={() => {
                    onValueChange(option.value);
                    setOpen(false);
                  }}
                >
                  <span className="truncate">{option.label}</span>
                  {option.value === value ? <CheckIcon className="ml-auto size-3.5" /> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

type FilterSearchProps = {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  className?: string;
};

function FilterSearch({
  value,
  onValueChange,
  placeholder = "Search…",
  className,
}: FilterSearchProps) {
  return (
    <div data-slot="filter-search" className={cn("relative", className)}>
      <SearchIcon
        aria-hidden="true"
        className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 size-3.5 text-muted-foreground"
      />
      <Input
        type="search"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        placeholder={placeholder}
        className="h-8 w-56 bg-card pl-8 text-(length:--text-chrome) shadow-none md:text-(length:--text-chrome) dark:bg-card"
      />
    </div>
  );
}

export { FilterBar, FilterCombobox, FilterSearch, FilterSelect };
