import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { Modal } from "./Modal";

type Entry = {
  id: string;
  trigger: RefObject<HTMLElement | null>;
  name: string;
  title?: string;
  content: ReactNode;
};
type Gallery = {
  active: boolean;
  selected: string | null;
  show: (id: string) => void;
  register: (entry: RefObject<Entry>) => () => void;
  update: () => void;
};
const Context = createContext<Gallery | null>(null);

function ImageDialog({
  entry,
  close,
  index = 0,
  count = 1,
  move,
}: {
  entry: Entry;
  close: () => void;
  index?: number;
  count?: number;
  move?: (direction: number) => void;
}) {
  const previous = index > 0;
  const next = index < count - 1;
  return createPortal(
    <div
      className="modal-backdrop attachment-image-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <Modal
        className="modal attachment-image-dialog"
        aria-label={`图片预览 ${entry.name}`}
        onKeyDown={(event) => {
          if (
            event.defaultPrevented ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey
          )
            return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
          } else if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            if (event.key === "ArrowLeft" ? previous : next)
              move?.(event.key === "ArrowLeft" ? -1 : 1);
          }
        }}
      >
        <header>
          <span title={entry.title}>{entry.name}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭图片预览"
            onClick={close}
          >
            <X size={18} />
          </button>
        </header>
        <div className="attachment-image-stage">
          <Fragment key={entry.id}>{entry.content}</Fragment>
        </div>
        {count > 1 && (
          <nav className="image-gallery-navigation" aria-label="图片切换">
            <button
              type="button"
              className="icon-button"
              aria-label="上一张图片"
              title="上一张图片（←）"
              aria-disabled={!previous}
              onClick={() => {
                if (previous) move?.(-1);
              }}
            >
              <ChevronLeft size={20} />
            </button>
            <span role="status" aria-live="polite" aria-atomic="true">
              {index + 1} / {count}
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label="下一张图片"
              title="下一张图片（→）"
              aria-disabled={!next}
              onClick={() => {
                if (next) move?.(1);
              }}
            >
              <ChevronRight size={20} />
            </button>
          </nav>
        )}
      </Modal>
    </div>,
    document.body,
  );
}

/** One stable modal per reading surface; image resources stay with their owners. */
export function ImageGallery({
  children,
  scope = "",
  active = true,
}: {
  children: ReactNode;
  scope?: string;
  active?: boolean;
}) {
  const entries = useRef(new Map<string, RefObject<Entry>>());
  const [selected, select] = useState<string | null>(null);
  const [, invalidate] = useReducer((value: number) => value + 1, 0);
  const selection = useRef(selected);
  selection.current = selected;
  const update = useCallback(() => {
    if (selection.current !== null) invalidate();
  }, []);
  const close = useCallback(() => select(null), []);
  useLayoutEffect(close, [scope, active, close]);
  const register = useCallback(
    (entry: RefObject<Entry>) => {
      const id = entry.current.id;
      entries.current.set(id, entry);
      update();
      return () => {
        entries.current.delete(id);
        select((current) => (current === id ? null : current));
        update();
      };
    },
    [update],
  );
  const context = useMemo(
    () => ({ active, selected, show: select, register, update }),
    [active, selected, register, update],
  );
  // Registration order can differ from transcript order after lazy reads or
  // prepended pages. Use the actual trigger order, without reading more history.
  const items = (selected === null ? [] : [...entries.current.values()])
    .map((entry) => entry.current)
    .filter((entry) => entry.trigger.current?.isConnected)
    .sort((a, b) =>
      a.trigger.current!.compareDocumentPosition(b.trigger.current!) &
      Node.DOCUMENT_POSITION_FOLLOWING
        ? -1
        : 1,
    );
  const index = items.findIndex((entry) => entry.id === selected);
  return (
    <Context.Provider value={context}>
      {children}
      {active && index >= 0 && (
        <ImageDialog
          entry={items[index]}
          index={index}
          count={items.length}
          close={close}
          move={(direction) => {
            const next = items[index + direction];
            if (next) select(next.id);
          }}
        />
      )}
    </Context.Provider>
  );
}

/** Standalone messages/tool results form a group; conversations supply a wider one. */
export function ImageGalleryBoundary({ children }: { children: ReactNode }) {
  return useContext(Context) ? (
    children
  ) : (
    <ImageGallery>{children}</ImageGallery>
  );
}

export function useImagePreview(
  identity: unknown,
  enabled: boolean,
  trigger: RefObject<HTMLElement | null>,
) {
  const gallery = useContext(Context);
  const id = useId();
  const [localOpen, setLocalOpen] = useState(false);
  const active = enabled && (gallery?.active ?? true);
  useLayoutEffect(() => setLocalOpen(false), [identity, active]);
  return {
    id,
    identity,
    active,
    trigger,
    gallery,
    open: active && (gallery ? gallery.selected === id : localOpen),
    show: () => {
      if (!active) return;
      trigger.current?.focus();
      if (gallery) gallery.show(id);
      else setLocalOpen(true);
    },
    close: () => setLocalOpen(false),
  };
}

export function ImagePreview({
  preview,
  name,
  title,
  children,
}: {
  preview: ReturnType<typeof useImagePreview>;
  name: string;
  title?: string;
  children: ReactNode;
}) {
  const { gallery, id, identity, active, open, trigger } = preview;
  const entry = useRef<Entry>({ id, trigger, name, title, content: children });
  entry.current = { id, trigger, name, title, content: children };
  const register = gallery?.register;
  const update = gallery?.update;
  useLayoutEffect(() => {
    if (active) return register?.(entry);
  }, [register, id, identity, active]);
  useLayoutEffect(() => {
    if (active) update?.();
  }, [update, active, name, title, children]);
  return !gallery && open ? (
    <ImageDialog entry={entry.current} close={preview.close} />
  ) : null;
}
