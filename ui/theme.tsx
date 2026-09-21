import { type ChangeEvent, type JSX, useCallback, useEffect, useState } from "react";

/**
 * System, Light or Dark, the way the design manual specifies it.
 *
 * A native select, the `auditmos-theme` key and `data-theme` on the document
 * element: the same three decisions the published site makes, so a person who
 * has used one has used the other. "System" is not a third palette but the
 * absence of an override, so choosing it removes what was stored rather than
 * storing the word.
 */

const KEY = "auditmos-theme";

type Theme = "dark" | "light" | "system";

const THEMES: readonly { readonly label: string; readonly value: Theme }[] = [
  { label: "◐ System", value: "system" },
  { label: "☀ Jasny", value: "light" },
  { label: "☾ Ciemny", value: "dark" },
];

function stored(): Theme {
  try {
    const saved = localStorage.getItem(KEY);

    return saved === "dark" || saved === "light" ? saved : "system";
  } catch {
    return "system";
  }
}

export function ThemeSelect(): JSX.Element {
  const [theme, setTheme] = useState<Theme>(stored);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;

    try {
      if (theme === "system") {
        localStorage.removeItem(KEY);
      } else {
        localStorage.setItem(KEY, theme);
      }
    } catch {
      /* The choice still applies to this tab when storage is unavailable. */
    }
  }, [theme]);

  const choose = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => setTheme(event.target.value as Theme),
    []
  );

  return (
    <div className="theme-control">
      <label className="sr-only" htmlFor="theme">
        Motyw
      </label>
      <select id="theme" onChange={choose} value={theme}>
        {THEMES.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
