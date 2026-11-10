import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  title: string;
  description: string;
  resetKey?: string;
  className?: string;
};

type State = { error: Error | null };

export class RenderErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error("unknown render error") };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) {
      const url = new URL(location.href);
      if (url.searchParams.has("__gamma_render_error")) {
        url.searchParams.delete("__gamma_render_error");
        history.replaceState(history.state, "", url);
      }
    }
    console.error("gamma render error", error, info.componentStack);
  }

  componentDidUpdate(previous: Props) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className={["render-failure", this.props.className].filter(Boolean).join(" ")} role="alert">
        <span className="status-mark" data-tone="danger" aria-hidden="true">!</span>
        <div className="render-failure-copy">
          <h2>{this.props.title}</h2>
          <p>{this.props.description}</p>
          <p className="render-failure-message">the error said: {this.state.error.message}</p>
          <button type="button" className="primary" onClick={() => location.reload()}>reload gamma</button>
        </div>
      </section>
    );
  }
}
