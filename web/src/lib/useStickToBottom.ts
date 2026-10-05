/**
 * Follow the tail of a scrolling log.
 *
 * While the reader is at the bottom, new content keeps them there. When they
 * scroll up, following stops and `atBottom` turns false, so the page can
 * offer a "jump to latest" control. Growth is watched with a ResizeObserver
 * on the content, which also catches streaming text and expanding cards.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const THRESHOLD_PX = 48;

export interface StickToBottom {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  atBottom: boolean;
  jumpToLatest: () => void;
}

export function useStickToBottom(): StickToBottom {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  /** True during a smooth jump, whose intermediate scroll events are not the reader's. */
  const jumpingRef = useRef(false);
  const [atBottom, setAtBottom] = useState(true);

  const pin = useCallback(() => {
    const scroller = scrollRef.current;
    if (scroller !== null) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, []);

  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (scroller === null || content === null) {
      return;
    }
    const onScroll = () => {
      const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      const bottom = distance <= THRESHOLD_PX;
      if (jumpingRef.current) {
        if (!bottom) {
          return;
        }
        jumpingRef.current = false;
      }
      followRef.current = bottom;
      setAtBottom(bottom);
    };
    const observer = new ResizeObserver(() => {
      if (followRef.current) {
        pin();
      } else {
        onScroll();
      }
    });
    observer.observe(content);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    pin();
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [pin]);

  const jumpToLatest = useCallback(() => {
    followRef.current = true;
    setAtBottom(true);
    const scroller = scrollRef.current;
    if (scroller === null) {
      return;
    }
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    jumpingRef.current = !reduce;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }, []);

  return { scrollRef, contentRef, atBottom, jumpToLatest };
}
