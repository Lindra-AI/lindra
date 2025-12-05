import {
  errors,
  type Browser,
  type BrowserContext,
  type Page,
  type CDPSession,
} from "playwright";
import { type StealthWaiter, type BrowserProvider } from "./providers.js";
import {
  type Coord,
  type Input,
  type Textarea,
  type Select,
  type Link,
  getScrollData,
  scroll,
  typeText,
  selectOption,
  snapshot,
} from "./dom.js";

class Tab {
  private ready: boolean = false;
  private closed: boolean = false;
  private page: Page;
  private getStealthPromise: StealthWaiter;
  private cdp: CDPSession;
  private width: number;
  private height: number;

  constructor(
    page: Page,
    getStealthPromise: StealthWaiter,
    cdp: CDPSession,
    width: number,
    height: number,
  ) {
    this.page = page;
    this.getStealthPromise = getStealthPromise;
    this.cdp = cdp;
    this.width = width;
    this.height = height;
  }

  isReady(): boolean {
    return this.ready;
  }

  isClosed(): boolean {
    return this.closed;
  }

  async init(skipWaits: boolean): Promise<void> {
    this.ready = false;
    if (!skipWaits) {
      await this.stealthWait();
      try {
        await this.page.waitForLoadState("domcontentloaded", {
          timeout: 30_000,
        });
        await this.loadWait();
      } catch (error) {}
      await this.page.waitForSelector("html");
    }
    this.ready = true;
  }

  async close() {
    this.closed = true;
    await this.page.close();
  }

  private async stealthWait() {
    const stealthPromise = this.getStealthPromise();
    if (stealthPromise) await stealthPromise;
  }

  private async loadWait(): Promise<boolean> {
    try {
      await this.page.waitForLoadState("load", { timeout: 30_000 });
      await this.page.waitForLoadState("networkidle", { timeout: 5_000 });
    } catch (error) {
      if (error instanceof errors.TimeoutError) {
        return false;
      } else throw error;
    }
    return true;
  }

  getUrl(): string {
    return this.page.url();
  }

  async getTitle(): Promise<string> {
    return await this.page.title();
  }

  async getScrollData(): Promise<{
    totalHeight: number;
    scrollPosition: number;
  }> {
    return await this.page.evaluate(getScrollData);
  }

  async screenshot(): Promise<string> {
    await this.stealthWait();
    const { data } = await this.cdp.send("Page.captureScreenshot", {
      format: "png",
    });
    return data;
  }

  async snapshot(): Promise<{
    inputs: Input[];
    textareas: Textarea[];
    selects: Select[];
    links: Link[];
  }> {
    await this.stealthWait();
    return await this.page.evaluate(snapshot);
  }

  async wait(ms: number): Promise<void> {
    await this.stealthWait();
    await new Promise((r) => setTimeout(r, ms));
  }

  async navigate(url: string): Promise<boolean> {
    await this.stealthWait();
    if (url.length === 0) {
      await this.page.goBack({
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    } else {
      await this.page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    }
    return await this.loadWait();
  }

  async reload(): Promise<boolean> {
    await this.stealthWait();
    await this.page.reload({
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    return await this.loadWait();
  }

  async scroll(
    coord: Coord,
    multiplier: number,
    vertical: boolean,
  ): Promise<number | null> {
    return await this.page.evaluate(scroll, {
      coord,
      multiplier,
      vertical,
    });
  }

  async click(coord: Coord, newTab: boolean): Promise<void> {
    await this.page.mouse.click(coord[0], coord[1], {
      button: newTab ? "middle" : "left",
    });
  }

  async type(coord: Coord, text: string, pressEnter: boolean): Promise<void> {
    await this.page.evaluate(typeText, {
      coord,
      text,
      pressEnter,
    });
  }

  async select(coord: Coord, values: string[]): Promise<void> {
    await this.page.evaluate(selectOption, {
      coord,
      values,
    });
  }
}

class BrowserController {
  private width: number;
  private height: number;
  private provider: BrowserProvider | null = null;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private tabs: Map<number, Tab> = new Map();
  private nextTabId: number = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  async init(provider: BrowserProvider) {
    if (this.provider !== null) {
      throw new Error("BrowserController already initialized");
    }

    this.provider = provider;
    this.browser = await this.provider.createBrowser(this.width, this.height);

    if (this.browser.contexts().length === 0) {
      throw new Error("No browser context found");
    }
    this.context = this.browser.contexts()[0]!;
    if (this.context.pages().length === 0) {
      throw new Error("No page found in browser context");
    }
    const firstTabId = await this.createTab(this.context.pages()[0]!);
    await this.getTab(firstTabId).init(true);

    this.context.on("page", async (page: Page) => {
      const tabId = await this.createTab(page);
      await this.getTab(tabId).init(false);
    });
  }

  async destroy() {
    if (this.browser === null || this.context === null) {
      throw new Error("BrowserController not initialized");
    }

    await this.context.close();
    await this.browser.close();
  }

  getTabIds(): number[] {
    return Array.from(this.tabs.keys());
  }

  getTab(tabId: number): Tab {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error("Tab ID not found");
    return tab;
  }

  private async createTab(page: Page): Promise<number> {
    if (this.provider === null || this.context === null) {
      throw new Error("BrowserProvider not initialized");
    }

    this.tabs.set(
      this.nextTabId,
      new Tab(
        page,
        this.provider.createStealthWaiter(page),
        await this.context.newCDPSession(page),
        this.width,
        this.height,
      ),
    );
    return this.nextTabId++;
  }

  async closeTab(tabId: number) {
    if (this.tabs.size === 1) throw new Error("Cannot close last tab");
    await this.getTab(tabId).close();
    this.tabs.delete(tabId);
  }
}

export { Tab, BrowserController };
