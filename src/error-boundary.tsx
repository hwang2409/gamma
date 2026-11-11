import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  title: string;
  description: string;
  resetKey?: string;
  className?: string;
  focusMode?: "outer" | "transcript";
};

type State = { error: Error | null };

export class RenderErrorBoundary extends Component<Props, State> {
  state: State = { error: null };
  private heading: HTMLHeadingElement | null = null;
  private transcriptHadFocus = false;
  private readonly rememberFocus = (event: FocusEvent) => {
    if (this.props.focusMode === "transcript") this.transcriptHadFocus = event.target instanceof Element && event.target.closest(".scroll") !== null;
  };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error("unknown render error") };
  }

  componentDidMount() {
    if (this.props.focusMode === "transcript") document.addEventListener("focus", this.rememberFocus, true);
  }

  componentWillUnmount() {
    document.removeEventListener("focus", this.rememberFocus, true);
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const shouldFocusHeading = this.props.focusMode !== "transcript" || this.transcriptHadFocus;
    if (shouldFocusHeading) this.heading?.focus({ preventScroll: true });
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
          <h2 ref={(heading) => { this.heading = heading; }} tabIndex={-1}>{this.props.title}</h2>
          <p>{this.props.description}</p>
          <p className="render-failure-message">the error said: {this.state.error.message}</p>
          <button type="button" className="primary" onClick={() => location.reload()}>reload gamma</button>
        </div>
      </section>
    );
  }
}
