/**
 * Markdown for model text, with raw HTML off.
 *
 * GitHub-flavored extras (tables, task lists, strikethrough) come from
 * remark-gfm. Fenced code renders through CodeBlock, with its language and a
 * copy button.
 */

import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { CopyButton } from "./CopyButton";

const LONG_CODE_LINES = 28;

function CodeBlock({ language, code }: { language: string; code: string }): React.JSX.Element {
  const lines = code.split("\n").length;
  return (
    <figure className="code-block">
      <figcaption>
        <span className="code-language">{language || "text"}</span>
        <CopyButton text={code} label="Copy" />
      </figcaption>
      <pre className={lines > LONG_CODE_LINES ? "long" : undefined} tabIndex={0}>
        <code>{code}</code>
      </pre>
    </figure>
  );
}

const components: Components = {
  // A fenced block arrives as <pre><code class="language-x">; the <pre> is
  // replaced so CodeBlock owns the whole figure.
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children;
    const props =
      child !== null && typeof child === "object" && "props" in child
        ? (child.props as { className?: string; children?: unknown })
        : {};
    const language = /language-([\w+-]+)/.exec(props.className ?? "")?.[1] ?? "";
    const code = String(props.children ?? "").replace(/\n$/, "");
    return <CodeBlock language={language} code={code} />;
  },
  table({ children }) {
    return (
      <div className="table-scroll" tabIndex={0}>
        <table>{children}</table>
      </div>
    );
  },
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
};

export function SafeMarkdown({ text }: { text: string }): React.JSX.Element {
  // react-markdown does not render raw HTML unless rehype-raw is added, and
  // it is not installed. Model and tool text can never become markup.
  return (
    <div className="markdown">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
  );
}
