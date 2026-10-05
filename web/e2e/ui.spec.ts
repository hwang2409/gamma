/**
 * Visual and accessibility pass over the main screens.
 *
 * Needs a running gamma whose backend allows the `fake` provider and whose
 * web dev server was given the token (`make dev` does both). Environment:
 *   GAMMA_WEB_URL     the web dev server (default http://localhost:5173)
 *   GAMMA_SCREENS_DIR where screenshots go (default /tmp/gamma-screens)
 *
 * Screenshots are for people to look at; they are not compared.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const SCREENS = process.env.GAMMA_SCREENS_DIR ?? "/tmp/gamma-screens";
mkdirSync(SCREENS, { recursive: true });

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;
const THEMES = ["light", "dark"] as const;

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENS, `${name}.png`), animations: "disabled" });
}

async function expectNoSeriousViolations(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  const summary = serious.map(
    (violation) =>
      `${violation.id}: ${violation.help} (${violation.nodes.map((node) => node.target.join(" ")).join(", ")})`,
  );
  expect(summary, `${label}: serious axe violations`).toEqual([]);
}

async function startFakeSession(page: Page, message: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("heading", { name: "New session" }).waitFor();
  await page.getByLabel("Provider").selectOption("fake");
  await page.getByRole("button", { name: "Start session" }).click();
  const input = page.getByRole("textbox", { name: "Message" });
  await expect(input).toBeEnabled();
  await input.fill(message);
  await input.press("Enter");
  await expect(page.getByText(`you said: ${message}`)).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("a live fake session streams a reply, then lists on the start page", async ({ page }) => {
  await startFakeSession(page, "Summarize the open pull requests");
  await expect(page.getByText("Ready")).toBeVisible();
  await page.getByRole("button", { name: "Back to sessions" }).click();
  await expect(page.getByRole("heading", { name: "Running" })).toBeVisible();
  await page.getByLabel("Provider").selectOption("fake");
  await expect(page.getByText("Summarize the open pull requests").first()).toBeVisible();
});

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    const tag = `${viewport.name}-${theme}`;

    test(`screens ${tag}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.emulateMedia({ colorScheme: theme });

      await page.goto("/");
      await page.getByLabel("Provider").selectOption("fake");
      await expect(page.getByRole("heading", { name: "Recent" })).toBeVisible();
      await expect(page.getByText("Loading sessions…")).toHaveCount(0);
      await shoot(page, `start-${tag}`);
      await expectNoSeriousViolations(page, `start ${tag}`);

      await startFakeSession(page, "What does this project do?");
      await shoot(page, `session-live-${tag}`);
      await expectNoSeriousViolations(page, `live session ${tag}`);
      await page.getByRole("button", { name: "End session" }).click();
      await expect(page.getByRole("heading", { name: "New session" })).toBeVisible();

      for (const variant of ["approval", "streaming", "empty"] as const) {
        await page.goto(`/#/fixture/${variant}`);
        await page.reload();
        await page.locator(".session").waitFor();
        await shoot(page, `fixture-${variant}-${tag}`);
        await expectNoSeriousViolations(page, `fixture ${variant} ${tag}`);
      }

      // The auth screen: every token is refused.
      await page.route("**/api/options", (route) =>
        route.fulfill({ status: 401, contentType: "application/json", body: '{"detail":"no"}' }),
      );
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Access token" })).toBeVisible();
      await shoot(page, `auth-${tag}`);
      await expectNoSeriousViolations(page, `auth ${tag}`);
      await page.unroute("**/api/options");
    });
  }
}

test("fixture: keyboard approves, tool groups expand, jump to latest", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/fixture/approval");
  await page.reload();
  const card = page.getByRole("region", { name: /Allow bash/ });
  await expect(card).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(card).toHaveCount(0);
  await expect(page.getByText("approved").last()).toBeVisible();

  const folded = page.getByRole("button", { name: /5 tool calls/ });
  await expect(folded).toHaveAttribute("aria-expanded", "false");
  await folded.click();
  await expect(page.getByText("tests/conftest.py")).toBeVisible();

  await page.locator(".session-scroll").evaluate((node) => node.scrollTo({ top: 0 }));
  const jump = page.getByRole("button", { name: "Jump to latest" });
  await expect(jump).toBeVisible();
  await jump.click();
  await expect(jump).toHaveCount(0);

  await page.keyboard.press("/");
  await expect(page.getByRole("textbox")).toBeFocused();
});

test("theme toggle overrides the system preference", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/#/fixture/empty");
  await page.reload();
  const toggle = page.getByRole("button", { name: /^Theme:/ });
  await toggle.click(); // system -> light
  await toggle.click(); // light -> dark
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(background).toBe("rgb(11, 11, 12)");
  await toggle.click(); // dark -> system
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
});
