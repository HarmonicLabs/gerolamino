/**
 * Page object for `popup.html` — mirrors WXT `playwright-e2e-testing/e2e/pages/popup.ts`.
 */
import type { Page } from "@playwright/test";

export class PopupPage {
  constructor(
    readonly page: Page,
    readonly extensionId: string,
  ) {}

  async goto(options?: { query?: string }): Promise<void> {
    const q = options?.query ?? "";
    const suffix = q.length > 0 ? (q.startsWith("?") ? q : `?${q}`) : "";
    await this.page.goto(`chrome-extension://${this.extensionId}/popup.html${suffix}`);
    await this.page.waitForLoadState("domcontentloaded");
  }

  modeLocal() {
    return this.page.getByTestId("mode-local");
  }

  modeGenesis() {
    return this.page.getByTestId("mode-genesis");
  }

  submit() {
    return this.page.getByTestId("submit");
  }

  error() {
    return this.page.getByTestId("error");
  }

  dropzone() {
    return this.page.getByTestId("snapshot-dropzone");
  }

  openInTab() {
    return this.page.getByTestId("open-in-tab");
  }

  resetSettings() {
    return this.page.getByTestId("reset-settings");
  }

  heading() {
    return this.page.getByRole("heading", { name: /Gerolamino/i });
  }
}
