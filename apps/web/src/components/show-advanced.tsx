"use client";

import { toast } from "@omniralph/ui";
import * as React from "react";
import { saveShowAdvancedPreference } from "@/lib/theme-actions";

type ShowAdvancedState = readonly [
  showAdvanced: boolean,
  setShowAdvanced: (value: boolean) => void,
];

const ShowAdvancedContext = React.createContext<ShowAdvancedState | null>(null);

/**
 * Holds the signed-in user's "Show advanced settings" preference, rendered by the
 * `(app)` layout from their user row.
 */
export function ShowAdvancedProvider({
  initial,
  children,
}: {
  initial: boolean;
  children: React.ReactNode;
}) {
  const [showAdvanced, setValue] = React.useState(initial);
  // A fresh server render (e.g. `router.refresh()`) brings the saved value.
  const [rendered, setRendered] = React.useState(initial);
  if (rendered !== initial) {
    setRendered(initial);
    setValue(initial);
  }
  const current = React.useRef(showAdvanced);
  React.useEffect(() => {
    current.current = showAdvanced;
  }, [showAdvanced]);

  const setShowAdvanced = React.useCallback((value: boolean) => {
    const previous = current.current;
    current.current = value;
    setValue(value);
    const revert = () => {
      // Only undo this change if no later one replaced it.
      if (current.current === value) {
        current.current = previous;
        setValue(previous);
      }
      toast("Couldn't save your preference.", { variant: "danger" });
    };
    void saveShowAdvancedPreference(value).then((result) => {
      if (!result.ok) revert();
    }, revert);
  }, []);

  const state = React.useMemo(
    () => [showAdvanced, setShowAdvanced] as const,
    [showAdvanced, setShowAdvanced],
  );
  return <ShowAdvancedContext.Provider value={state}>{children}</ShowAdvancedContext.Provider>;
}

/**
 * Whether the user shows advanced settings (routing rules, playbooks, repo playbook
 * bindings, chat playbook choice and channel overrides), and a setter that updates at
 * once, saves it, and reverts with an error toast if the save fails. It only decides
 * what the UI shows: every setting works the same either way.
 */
export function useShowAdvanced(): ShowAdvancedState {
  const state = React.useContext(ShowAdvancedContext);
  if (!state) throw new Error("useShowAdvanced must be used inside the signed-in app shell");
  return state;
}
