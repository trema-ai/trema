import { useTheme } from "next-themes";

import { PageHeader } from "#web/components/trema/page-header.tsx";
import { SettingRow, SettingsSection } from "#web/components/trema/settings-section.tsx";
import { Label } from "#web/components/ui/label.tsx";
import { RadioGroup, RadioGroupItem } from "#web/components/ui/radio-group.tsx";

const themes = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function SettingsAppearancePage() {
  const { theme, setTheme } = useTheme();
  return (
    <main className="mx-auto w-full max-w-3xl p-4 sm:p-6 lg:p-8">
      <PageHeader title="Appearance" description="Choose how Trema looks on this device." />
      <SettingsSection title="Theme">
        <SettingRow
          label="Color theme"
          description="Use your system setting or choose a fixed theme."
          control={
            <RadioGroup value={theme ?? "system"} onValueChange={setTheme} className="flex gap-4">
              {themes.map((option) => (
                <div key={option.value} className="flex items-center gap-2">
                  <RadioGroupItem value={option.value} id={`theme-${option.value}`} />
                  <Label htmlFor={`theme-${option.value}`} className="text-chrome font-normal">
                    {option.label}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          }
        />
      </SettingsSection>
    </main>
  );
}
