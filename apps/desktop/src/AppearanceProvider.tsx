import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import {
  applyAppearance,
  readAppearance,
  resolveTheme,
  saveAppearance,
  type Appearance,
  type ThemeKind,
} from "./appearance";
const AppearanceContext = createContext<{
  settings: Appearance;
  kind: ThemeKind;
  error: string;
  update: (settings: Appearance) => void;
} | null>(null);
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(readAppearance);
  const [settings, setSettings] = useState(initial.settings);
  const [error, setError] = useState(initial.error);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const change = () => setSystemDark(query.matches);
    change();
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  useLayoutEffect(
    () => applyAppearance(settings, systemDark),
    [settings, systemDark],
  );
  function update(next: Appearance) {
    setSettings(next);
    setError(saveAppearance(next));
  }
  return (
    <AppearanceContext.Provider
      value={{
        settings,
        kind: resolveTheme(settings.mode, systemDark),
        error,
        update,
      }}
    >
      {children}
    </AppearanceContext.Provider>
  );
}
export function useAppearance() {
  const context = useContext(AppearanceContext);
  if (!context) throw new Error("AppearanceProvider is required");
  return context;
}
