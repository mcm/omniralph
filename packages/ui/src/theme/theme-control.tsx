"use client";

import { IconDeviceDesktop, IconMoon, IconSun } from "@tabler/icons-react";
import { SegmentedControl, type SegmentedOption } from "../controls/index.js";
import type { ThemePreference } from "./resolve.js";
import { useTheme } from "./theme-provider.js";

export const THEME_OPTIONS: readonly SegmentedOption<ThemePreference>[] = [
  { value: "system", label: "System", icon: IconDeviceDesktop },
  { value: "dark", label: "Dark", icon: IconMoon },
  { value: "light", label: "Light", icon: IconSun },
];

export interface ThemeControlProps {
  size?: "md" | "sm";
  className?: string;
}

/**
 * The theme choice: a "Theme" segmented control (System, Dark, Light) bound to the nearest
 * `ThemeProvider`. Choosing applies the theme at once and calls its `onPreferenceChange`.
 */
export function ThemeControl({ size = "sm", className }: ThemeControlProps) {
  const { preference, setPreference } = useTheme();
  return (
    <SegmentedControl
      aria-label="Theme"
      options={THEME_OPTIONS}
      value={preference}
      onValueChange={setPreference}
      size={size}
      className={className}
    />
  );
}
