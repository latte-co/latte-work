import { createContext } from "react";
import type { SourceData } from "./sourceLoader";

/** Workspace hooks that make inline references in messages actionable. */
export interface MessageActions {
  /** Open a project-relative path in the workspace file browser. */
  openFile?: (path: string) => void;
  /** Absolute paths belong to this host and can leave the app locally. */
  localHost?: boolean;
  /** Absolute project root, used to resolve local editor and file-manager calls. */
  projectRoot?: string;
  /** Bounded project-file read shared by save-as and content copy. */
  readProjectFile?: (
    path: string,
    valid?: () => boolean,
  ) => Promise<SourceData>;
  /** Display-only read of an absolute path rendered as a message image. */
  loadExternalImage?: (
    path: string,
    valid: () => boolean,
  ) => Promise<SourceData>;
  /** Menu actions report failures to a persistent status surface. */
  reportError?: (text: string) => void;
}
export const MessageActionsContext = createContext<MessageActions>({});
