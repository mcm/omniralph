"use client";

import * as RadixTabs from "@radix-ui/react-tabs";
import type { ReactNode } from "react";

/** `need` draws the count in the accent (needs you), `fail` in coral, otherwise tertiary. */
export type TabCountTone = "default" | "need" | "fail";

export interface TabItem<Value extends string = string> {
  value: Value;
  label: string;
  /** An optional count after the label; it is part of the tab's accessible name. */
  count?: number;
  countTone?: TabCountTone;
  disabled?: boolean;
}

export type TabsProps<Value extends string = string> = {
  tabs: readonly TabItem<Value>[];
  value?: Value;
  defaultValue?: Value;
  onValueChange?: (value: Value) => void;
  /** Panels (`TabPanel`), or content that the selected tab filters. */
  children?: ReactNode;
  className?: string;
} & (
  | {
      /** Names the tab list for assistive tech. */ "aria-label": string;
      "aria-labelledby"?: undefined;
    }
  | { "aria-label"?: undefined; "aria-labelledby": string }
);

/** A tab's accessible name: its label, then its count ("Needs you, 4"). */
export function tabAccessibleName(tab: Pick<TabItem, "label" | "count">): string {
  return tab.count === undefined ? tab.label : `${tab.label}, ${tab.count}`;
}

/**
 * Views of one thing (Radix tabs). Left/Right move focus and select (automatic activation),
 * Home/End jump to the first and last tab. The strip scrolls horizontally instead of
 * wrapping.
 */
export function Tabs<Value extends string = string>({
  tabs,
  value,
  defaultValue,
  onValueChange,
  children,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: TabsProps<Value>) {
  return (
    <RadixTabs.Root
      value={value}
      defaultValue={defaultValue ?? tabs.find((tab) => !tab.disabled)?.value}
      onValueChange={onValueChange as ((value: string) => void) | undefined}
      activationMode="automatic"
      className={["or-tabs-root", className].filter(Boolean).join(" ")}
    >
      <RadixTabs.List className="or-tabs" aria-label={ariaLabel} aria-labelledby={ariaLabelledBy}>
        {tabs.map((tab) => (
          <RadixTabs.Trigger
            key={tab.value}
            value={tab.value}
            disabled={tab.disabled}
            className="or-tab"
            aria-label={tab.count === undefined ? undefined : tabAccessibleName(tab)}
          >
            <span className="or-tab__label">{tab.label}</span>
            {tab.count !== undefined && (
              <span
                className={[
                  "or-tab__count",
                  tab.countTone && tab.countTone !== "default" && `or-tab__count--${tab.countTone}`,
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-hidden="true"
              >
                {tab.count}
              </span>
            )}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {children}
    </RadixTabs.Root>
  );
}

export interface TabPanelProps {
  /** The `value` of the tab this panel belongs to. */
  value: string;
  children?: ReactNode;
  className?: string;
}

/** The content shown while its tab is selected (`role="tabpanel"`, labeled by the tab). */
export function TabPanel({ value, children, className }: TabPanelProps) {
  return (
    <RadixTabs.Content
      value={value}
      className={["or-tab-panel", className].filter(Boolean).join(" ")}
    >
      {children}
    </RadixTabs.Content>
  );
}
