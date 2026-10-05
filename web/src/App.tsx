import { useState } from "react";

import { SessionPage } from "./components/SessionPage";
import { StartPage } from "./components/StartPage";
import type { SessionView } from "./lib/protocol";

export function App(): React.JSX.Element {
  const [open, setOpen] = useState<SessionView | null>(null);

  if (open === null) {
    return <StartPage onOpen={setOpen} />;
  }
  return (
    <SessionPage
      sessionId={open.session_id}
      initial={open}
      onLeave={() => setOpen(null)}
    />
  );
}
