import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RenderErrorBoundary } from "../src/error-boundary";

const props = {
  children: <p>run</p>,
  title: "something broke",
  description: "reload to continue.",
  resetKey: "run-a",
};

test("a render error becomes a readable reload state without its stack", () => {
  const boundary = new RenderErrorBoundary(props);
  boundary.state = RenderErrorBoundary.getDerivedStateFromError(new Error("plain failure"));
  const html = renderToStaticMarkup(boundary.render());

  expect(html).toContain("something broke");
  expect(html).toContain("the error said: plain failure");
  expect(html).toContain("reload gamma");
  expect(html).not.toContain("Error: plain failure");
});

test("a changed run clears the transcript render error", () => {
  const boundary = new RenderErrorBoundary({ ...props, resetKey: "run-b" });
  boundary.state = RenderErrorBoundary.getDerivedStateFromError(new Error("plain failure"));
  boundary.setState = (state) => { boundary.state = { ...boundary.state, ...(state as object) }; };

  boundary.componentDidUpdate(props);

  expect(boundary.state.error).toBeNull();
});
