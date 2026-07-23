import type { ReactNode } from "react";

type SettingsSectionProps = {
  title: string;
  description?: string;
  children: ReactNode;
};

function SettingsSection({ title, description, children }: SettingsSectionProps) {
  return (
    <section data-slot="settings-section">
      <h3 className="text-chrome font-medium text-foreground">{title}</h3>
      {description ? <p className="mt-0.5 text-meta text-muted-foreground">{description}</p> : null}
      <div className="mt-2 divide-y rounded-md border bg-card">{children}</div>
    </section>
  );
}

type SettingRowProps = {
  label: string;
  description?: string;
  control: ReactNode;
  orientation?: "row" | "stack";
};

function SettingRow({ label, description, control, orientation = "row" }: SettingRowProps) {
  if (orientation === "stack") {
    return (
      <div data-slot="setting-row" className="px-4 py-3.5">
        <div className="text-chrome font-medium">{label}</div>
        {description ? (
          <p className="mt-0.5 text-meta text-muted-foreground">{description}</p>
        ) : null}
        <div className="mt-2.5">{control}</div>
      </div>
    );
  }

  return (
    <div data-slot="setting-row" className="flex items-center justify-between gap-8 px-4 py-3.5">
      <div className="min-w-0">
        <div className="text-chrome font-medium">{label}</div>
        {description ? (
          <p className="mt-0.5 text-meta text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center">{control}</div>
    </div>
  );
}

export { SettingRow, SettingsSection };
