import { Page } from 'playwright';
import { v4 as uuidv4 } from 'uuid';
import { BrowserManager } from '../crawler/browser-manager';
import { RecordedAction, RecordingSession } from '@/lib/types/crawler';
import fs from 'fs/promises';
import path from 'path';

export class ManualRecorder {
  private browserManager: BrowserManager;
  private recordingSession: RecordingSession | null = null;
  private isRecording = false;
  private currentPage: Page | null = null;
  private currentUrl: string = '';
  private screenshotIndex = 0;

  constructor() {
    this.browserManager = new BrowserManager();
  }

  async startRecording(startUrl: string): Promise<string> {
    if (this.isRecording) {
      throw new Error('Recording is already in progress');
    }

    // Create recording session
    const sessionId = uuidv4();
    this.recordingSession = {
      id: sessionId,
      start_time: new Date().toISOString(),
      start_url: startUrl,
      actions: [],
      screenshots: []
    };

    // Initialize browser
    await this.browserManager.initialize();
    this.currentPage = await this.browserManager.createPage();
    
    // Setup page listeners for user actions
    await this.setupPageListeners();
    
    // Navigate to start URL
    await this.currentPage.goto(startUrl);
    this.currentUrl = startUrl;
    
    // Take initial screenshot
    await this.takeScreenshot('initial_load');
    
    // Capture initial page HTML
    await this.capturePageHtml();
    
    this.isRecording = true;
    
    console.log(`Recording session started: ${sessionId}`);
    return sessionId;
  }

  async stopRecording(): Promise<RecordingSession | null> {
    if (!this.isRecording || !this.recordingSession) {
      return null;
    }

    this.recordingSession.end_time = new Date().toISOString();
    this.isRecording = false;

    // Save recording session to file
    await this.saveRecordingSession();
    
    // Cleanup and close browser window
    if (this.currentPage) {
      await this.currentPage.close();
      this.currentPage = null;
    }
    await this.browserManager.cleanup();
    
    const session = this.recordingSession;
    this.recordingSession = null;
    
    console.log(`Recording session stopped and browser window closed: ${session.id}`);
    return session;
  }

  private async setupPageListeners() {
    if (!this.currentPage) return;

    // Listen for navigation events
    this.currentPage.on('framenavigated', async (frame) => {
      if (frame === this.currentPage!.mainFrame()) {
        const newUrl = frame.url();
        if (newUrl !== this.currentUrl) {
          await this.recordAction({
            type: 'navigation',
            from_url: this.currentUrl,
            to_url: newUrl,
            action_description: `Navigated from ${this.currentUrl} to ${newUrl}`
          });
          this.currentUrl = newUrl;
          await this.takeScreenshot('navigation');
          // Capture page HTML on navigation
          await this.capturePageHtml();
        }
      }
    });

    // Listen for clicks
    await this.currentPage.addInitScript(() => {
      // Helper function to get CSS selector
      function getSelector(element: HTMLElement): string {
        if (element.id) return `#${element.id}`;
        if (element.className) {
          const classes = element.className.split(' ').filter(c => c.length > 0);
          if (classes.length > 0) return `.${classes.join('.')}`;
        }
        return element.tagName.toLowerCase();
      }
      
      // Now add the click listener
      document.addEventListener('click', (event) => {
        const target = event.target as HTMLElement;
        (window as any).lastClickData = {
          x: event.clientX,
          y: event.clientY,
          selector: getSelector(target),
          text: target.textContent?.trim() || target.innerText?.trim() || '',
          tagName: target.tagName,
          href: (target as HTMLAnchorElement).href || (target.closest('a') as HTMLAnchorElement)?.href || '',
          timestamp: Date.now()
        };
      });
    });

    // Poll for click events
    setInterval(async () => {
      if (!this.isRecording || !this.currentPage) return;
      
      try {
        const clickData = await this.currentPage.evaluate(() => {
          const data = (window as any).lastClickData;
          (window as any).lastClickData = null;
          return data;
        });

        if (clickData) {
          // Use href as to_url if it exists, otherwise current URL
          const toUrl = clickData.href || this.currentUrl;
          
          let actionDescription = `Clicked on ${clickData.text || clickData.tagName}`;
          if (clickData.href) {
            actionDescription += ` (link to: ${clickData.href})`;
          }
          actionDescription += ` at (${clickData.x}, ${clickData.y})`;
          
          await this.recordAction({
            type: 'click',
            from_url: this.currentUrl,
            to_url: toUrl,
            action_description: actionDescription,
            position: { x: clickData.x, y: clickData.y },
            element_selector: clickData.selector,
            element_text: clickData.text,
            element_href: clickData.href
          });
        }
      } catch (error) {
        // Ignore errors from closed pages
      }
    }, 100);

    // Listen for keyboard events
    this.currentPage.on('console', async (msg) => {
      if (msg.type() === 'log' && msg.text().startsWith('KEYBOARD:')) {
        const keyData = JSON.parse(msg.text().replace('KEYBOARD:', ''));
        await this.recordAction({
          type: keyData.type,
          from_url: this.currentUrl,
          to_url: this.currentUrl,
          action_description: `Key ${keyData.type}: ${keyData.key}`,
          key: keyData.key,
          input_text: keyData.text
        });
      }
    });

    // Inject keyboard listener
    await this.currentPage.addInitScript(() => {
      let inputBuffer = '';
      
      document.addEventListener('keydown', (event) => {
        console.log(`KEYBOARD:${JSON.stringify({
          type: 'keydown',
          key: event.key,
          text: inputBuffer
        })}`);
      });

      document.addEventListener('input', (event) => {
        const target = event.target as HTMLInputElement;
        if (target && target.value) {
          inputBuffer = target.value;
          console.log(`KEYBOARD:${JSON.stringify({
            type: 'type',
            key: 'input',
            text: target.value
          })}`);
        }
      });
    });
  }

  private async recordAction(actionData: (Partial<RecordedAction> & { action_description?: string })) {
    if (!this.isRecording || !this.recordingSession) return;

    const action: RecordedAction = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      type: actionData.type || 'navigation',
      from_url: actionData.from_url || this.currentUrl,
      to_url: actionData.to_url || this.currentUrl,
      actions: [{
        action_description: actionData.action_description || 'Unknown action'
      }],
      position: actionData.position,
      element_selector: actionData.element_selector,
      element_text: actionData.element_text,
      input_text: actionData.input_text,
      key: actionData.key,
      scroll_delta: actionData.scroll_delta
    };

    this.recordingSession.actions.push(action);
    console.log(`Recorded action: ${action.actions[0]?.action_description || 'Unknown action'}`);
  }

  private async takeScreenshot(suffix: string) {
    if (!this.currentPage || !this.recordingSession) return;

    try {
      const sessionDir = path.join(process.cwd(), 'recordings', `session_${this.recordingSession.id}`);
      const screenshotsDir = path.join(sessionDir, 'screenshots');
      await fs.mkdir(screenshotsDir, { recursive: true });

      this.screenshotIndex++;
      const filename = `${this.screenshotIndex.toString().padStart(3, '0')}_${suffix}.png`;
      const filepath = path.join(screenshotsDir, filename);

      await this.currentPage.screenshot({
        path: filepath,
        fullPage: true
      });

      this.recordingSession.screenshots.push(filename);
      console.log(`Screenshot saved: ${filename}`);
    } catch (error) {
      console.error('Error taking screenshot:', error);
    }
  }

  private async saveRecordingSession() {
    if (!this.recordingSession) return;

    try {
      const sessionDir = path.join(process.cwd(), 'recordings', `session_${this.recordingSession.id}`);
      await fs.mkdir(sessionDir, { recursive: true });

      const filename = `session_${this.recordingSession.id}_${Date.now()}.json`;
      const filepath = path.join(sessionDir, filename);

      await fs.writeFile(filepath, JSON.stringify(this.recordingSession, null, 2));
      console.log(`Recording session saved: ${filename}`);
    } catch (error) {
      console.error('Error saving recording session:', error);
    }
  }

  getCurrentUrl(): string {
    return this.currentUrl;
  }

  isRecordingActive(): boolean {
    return this.isRecording;
  }

  getRecordingSession(): RecordingSession | null {
    return this.recordingSession;
  }

  private generateSlugFromUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      // Remove protocol, replace special chars with hyphens
      let slug = urlObj.hostname + urlObj.pathname + urlObj.search;
      slug = slug
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/--+/g, '-');
      return slug || 'index';
    } catch (error) {
      return 'unknown-page';
    }
  }

  private async capturePageHtml() {
    console.log('capturePageHtml called for URL:', this.currentUrl);
    if (!this.currentPage || !this.recordingSession) return;

    try {
      const sessionDir = path.join(process.cwd(), 'recordings', `session_${this.recordingSession.id}`);
      const pagesDir = path.join(sessionDir, 'pages');
      await fs.mkdir(pagesDir, { recursive: true });

      // Generate slug from current URL
      const slug = this.generateSlugFromUrl(this.currentUrl);
      const filename = `${slug}.html`;
      const filepath = path.join(pagesDir, filename);

      // Check if file already exists
      try {
        await fs.access(filepath);
        console.log(`HTML page already exists: ${filename}`);
        return;
      } catch (error) {
        // File doesn't exist, continue to save
      }

      // Get page HTML content
      const htmlContent = await this.currentPage.content();
      
      // Save HTML to file
      await fs.writeFile(filepath, htmlContent);
      console.log(`HTML page saved: ${filename} at ${filepath}`);
    } catch (error) {
      console.error('Error capturing page HTML:', error);
    }
  }
}