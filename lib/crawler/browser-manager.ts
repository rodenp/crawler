import { chromium, Browser, Page, BrowserContext } from 'playwright';

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;

  async initialize(headless: boolean = true) {
    this.browser = await chromium.launch({
      headless: headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--remote-debugging-port=9222', // Enable remote debugging for live sessions
        '--remote-allow-origins=*',
      ]
    });

    this.context = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: this.getRandomUserAgent(),
      permissions: ['geolocation', 'notifications'],
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      },
      javaScriptEnabled: true,
      bypassCSP: true,
    });
  }

  async createPage(): Promise<Page> {
    if (!this.context) {
      throw new Error('Browser context not initialized');
    }

    const page = await this.context.newPage();

    // Add human-like behavior
    await this.setupHumanBehavior(page);

    return page;
  }

  private async setupHumanBehavior(page: Page) {
    // Randomize viewport slightly
    const width = 1920 + Math.floor(Math.random() * 100);
    const height = 1080 + Math.floor(Math.random() * 100);
    await page.setViewportSize({ width, height });

    // Override navigator properties for better stealth
    await page.addInitScript(() => {
      // Remove webdriver property
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
      
      // Mock plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
          { name: 'Native Client', filename: 'internal-nacl-plugin' }
        ],
      });
      
      // Set realistic languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });

      // Mock chrome runtime
      (window as any).chrome = (window as any).chrome || {};
      (window as any).chrome.runtime = (window as any).chrome.runtime || {
        onConnect: null,
        onMessage: null
      };

      // Remove automation indicators
      const automationProps = [
        '__webdriver_script_fn', '__webdriver_evaluate', '__selenium_unwrapped',
        '__webdriver_unwrapped', '__fxdriver_evaluate', '__driver_unwrapped',
        '__webdriver_script_func', '__webdriver_script_function'
      ];
      
      automationProps.forEach(prop => {
        delete (window as any)[prop];
      });
    });
  }

  private getRandomUserAgent(): string {
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    ];
    
    return userAgents[Math.floor(Math.random() * userAgents.length)];
  }

  async humanDelay(min: number = 200, max: number = 2000): Promise<void> {
    const delay = Math.floor(Math.random() * (max - min) + min);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  async humanType(page: Page, selector: string, text: string) {
    const element = await page.locator(selector).first();
    await element.click();
    
    for (const char of text) {
      await element.pressSequentially(char, { delay: Math.random() * 150 + 50 });
      
      // Occasionally make a "typo" and correct it
      if (Math.random() < 0.02) {
        const typo = String.fromCharCode(97 + Math.floor(Math.random() * 26));
        await element.pressSequentially(typo, { delay: 100 });
        await this.humanDelay(200, 500);
        await element.press('Backspace');
      }
    }
  }

  async humanScroll(page: Page) {
    const scrollAmount = Math.floor(Math.random() * 500) + 100;
    await page.mouse.wheel(0, scrollAmount);
    await this.humanDelay(500, 1500);
  }

  async humanMouseMove(page: Page) {
    const x = Math.floor(Math.random() * 1920);
    const y = Math.floor(Math.random() * 1080);
    
    // Move mouse in a curve
    const steps = Math.floor(Math.random() * 5) + 3;
    for (let i = 0; i < steps; i++) {
      const progress = i / steps;
      const currentX = x * progress;
      const currentY = y * progress + Math.sin(progress * Math.PI) * 50;
      await page.mouse.move(currentX, currentY);
      await this.humanDelay(50, 150);
    }
  }

  async humanClick(page: Page, element: any) {
    // Get element center position
    const box = await element.boundingBox();
    if (box) {
      // Add some randomness to click position
      const x = box.x + box.width / 2 + (Math.random() - 0.5) * 10;
      const y = box.y + box.height / 2 + (Math.random() - 0.5) * 10;
      
      // Move mouse to element first
      await page.mouse.move(x, y);
      await this.humanDelay(100, 300);
      
      // Click with human-like timing
      await page.mouse.click(x, y);
    } else {
      // Fallback to element click if no bounding box
      await element.click();
    }
  }

  getBrowser(): Browser | null {
    return this.browser;
  }

  async cleanup() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
    }
  }
}