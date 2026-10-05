/**
 * Content that opens and closes in place.
 *
 * The height animates through `grid-template-rows` (0fr to 1fr), a CSS
 * transition, so a second click mid-way reverses smoothly. Children mount on
 * first open and stay mounted, so closing animates too; while closed the
 * content is `inert` (not focusable, not read).
 */

import { useState } from "react";

interface Props {
  open: boolean;
  id?: string;
  className?: string;
  children: React.ReactNode;
}

export function Reveal({ open, id, className, children }: Props): React.JSX.Element {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) {
    setMounted(true);
  }
  return (
    <div
      id={id}
      className={className ? `reveal ${className}` : "reveal"}
      data-open={open}
      inert={!open}
    >
      <div className="reveal-inner">{mounted && children}</div>
    </div>
  );
}
