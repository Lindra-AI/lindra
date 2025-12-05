import { chromium, type Browser, type Page } from "playwright";
import Browserbase from "@browserbasehq/sdk";

type StealthWaiter = () => Promise<void> | null;

interface BrowserProvider {
  createBrowser: (width: number, height: number) => Promise<Browser>;
  createStealthWaiter: (page: Page) => StealthWaiter;
}

class LocalProvider implements BrowserProvider {
  async createBrowser(width: number, height: number) {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height } });
    await context.newPage();
    return browser;
  }

  createStealthWaiter(page: Page) {
    return () => null;
  }
}

class BrowserbaseProvider implements BrowserProvider {
  private client: Browserbase | null = null;
  private projectId: string | null = null;

  constructor(apiKey: string, projectId: string) {
    this.client = new Browserbase({ apiKey });
    this.projectId = projectId;
  }

  async createBrowser(width: number, height: number) {
    if (!this.client || !this.projectId) {
      throw new Error("Browserbase not initialized");
    }

    const session = await this.client.sessions.create({
      projectId: this.projectId,
      browserSettings: { viewport: { width, height } },
    });
    return await chromium.connectOverCDP(session.connectUrl);
  }

  createStealthWaiter(page: Page) {
    let captchaPromise: Promise<void> | null = null;
    let captchaResolver: (() => void) | null = null;

    page.on("console", (msg) => {
      const text = msg.text();
      if (text === "browserbase-solving-started") {
        captchaPromise = new Promise((resolve) => {
          captchaResolver = resolve;
        });
      } else if (text === "browserbase-solving-finished") {
        if (captchaResolver) {
          captchaResolver();
          captchaResolver = null;
          captchaPromise = null;
        }
      }
    });
    return () => captchaPromise;
  }
}

export {
  type StealthWaiter,
  type BrowserProvider,
  LocalProvider,
  BrowserbaseProvider,
};
