import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

/** Within this distance of the bottom, the view counts as at the bottom. */
const NEAR_BOTTOM_PX = 60;
/** Beyond this distance the jump-to-latest affordance appears. */
const FAR_BOTTOM_PX = 400;

/**
 * Chat-style follow mode for a scroll container: while the reader is at the
 * bottom, growth re-pins the view there; scrolling up disengages; returning
 * to the bottom re-engages. Scrolls this hook performs are flagged so they
 * are never misread as the reader moving — only user scrolls change follow
 * state. `away` is true once the reader is far enough up that a
 * jump-to-latest affordance earns its place.
 *
 * Attach `viewportRef` to the scrolling element and `contentRef` to the
 * element whose growth should keep the view pinned.
 */
export function useStickToBottom(): {
  viewportRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  away: boolean;
  scrollToBottom: () => void;
} {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const selfScrollRef = useRef(false);
  const [away, setAway] = useState(false);

  // Flags the pin only when the assignment actually moved the position: an
  // unmoved scrollTop fires no scroll event, and a flag with no event to
  // clear it would swallow the reader's next real scroll.
  const pinToBottom = useCallback((viewport: HTMLDivElement) => {
    const before = viewport.scrollTop;
    viewport.scrollTop = viewport.scrollHeight;
    if (viewport.scrollTop !== before) selfScrollRef.current = true;
  }, []);

  const scrollToBottom = useCallback(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    followRef.current = true;
    pinToBottom(viewport);
    setAway(false);
  }, [pinToBottom]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (viewport === null || content === null) return;

    const gap = () => viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;

    const onScroll = () => {
      if (selfScrollRef.current) {
        selfScrollRef.current = false;
        return;
      }
      followRef.current = gap() <= NEAR_BOTTOM_PX;
      setAway(gap() > Math.max(FAR_BOTTOM_PX, viewport.clientHeight));
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });

    // Growth re-pins in the same frame while following; while not following
    // it only moves the jump affordance's threshold.
    const observer = new ResizeObserver(() => {
      if (followRef.current) {
        pinToBottom(viewport);
      } else {
        setAway(gap() > Math.max(FAR_BOTTOM_PX, viewport.clientHeight));
      }
    });
    observer.observe(content);

    return () => {
      viewport.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [pinToBottom]);

  return { viewportRef, contentRef, away, scrollToBottom };
}
