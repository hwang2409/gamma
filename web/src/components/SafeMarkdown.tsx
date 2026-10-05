/** Markdown for model text, with raw HTML off. */

import Markdown from "react-markdown";

export function SafeMarkdown({ text }: { text: string }): React.JSX.Element {
  // react-markdown does not render raw HTML unless rehype-raw is added, and
  // it is not installed. Model and tool text can never become markup.
  return (
    <div className="markdown">
      <Markdown>{text}</Markdown>
    </div>
  );
}
