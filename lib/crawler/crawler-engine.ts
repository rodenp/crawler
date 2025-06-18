import { Page } from 'playwright';
import { v4 as uuidv4 } from 'uuid';
import PQueue from 'p-queue';
import robotsParser from 'robots-parser';
import { BrowserManager } from './browser-manager';
import { LiveBrowserSession } from '../recorder/browser-session';
import { 
  CrawlConfig, 
  CrawlMetadata, 
  CrawlResult, 
  PageData, 
  LinkRelationship,
  CrawlError,
  CrawlProgress,
  CrawlEvent,
  BrowserAction,
  RecordedAction,
  RecordingSession 
} from '@/lib/types/crawler';

export class CrawlerEngine {
  private browserManager: BrowserManager;
  private crawlId: string;
  private metadata: CrawlMetadata;
  private pages: PageData[] = [];
  private linkRelationships: LinkRelationship[] = [];
  private errors: CrawlError[] = [];
  private visitedUrls = new Set<string>();
  private urlQueue: PQueue;
  private robotsTxt: any = null;
  private progressCallback?: (progress: CrawlProgress) => void;
  private config: CrawlConfig;
  private events: CrawlEvent[] = []; // New: event log
  private browserActions: BrowserAction[] = []; // New: browser actions
  private latestScreenshot: string | null = null; // New: latest screenshot
  private shouldStop: boolean = false; // New: stop flag
  private liveStreamInterval: NodeJS.Timeout | null = null; // Live streaming timer
  private currentPage: Page | null = null; // Current active page
  private screenshotTaken = new Set<string>(); // Track which URLs have been screenshotted
  private clickableElementsByUrl = new Map<string, any[]>(); // Store clickable elements by URL
  private isRecording = false; // Recording state
  private recordingSession: RecordingSession | null = null; // Current recording session
  private recordedActions: RecordedAction[] = []; // Recorded actions for current session
  public browserSession: LiveBrowserSession | null = null; // Live browser session for record mode

  private generateBreadcrumbTrail(url: string): string {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      
      // Split path into segments and clean them up
      const segments = pathname.split('/').filter(segment => segment.length > 0);
      
      if (segments.length === 0) {
        return 'Home';
      }
      
      // Convert slug segments to readable breadcrumbs
      const breadcrumbs = ['Home'];
      
      for (const segment of segments) {
        // Convert kebab-case and snake_case to Title Case
        const readable = segment
          .replace(/[-_]/g, ' ')
          .replace(/\b\w/g, char => char.toUpperCase())
          .replace(/\d+/g, match => `#${match}`); // Convert numbers to ID format
        
        breadcrumbs.push(readable);
      }
      
      return breadcrumbs.join(' > ');
    } catch (error) {
      return 'Unknown Path';
    }
  }

  constructor(config: CrawlConfig) {
    this.config = config;
    this.browserManager = new BrowserManager();
    this.crawlId = uuidv4();
    this.urlQueue = new PQueue({ concurrency: 3, interval: 1000, intervalCap: config.rateLimit });
    
    this.metadata = {
      start_url: config.startUrl,
      start_time: new Date().toISOString(),
      total_pages: 0,
      successful_crawls: 0,
      failed_crawls: 0,
      max_depth: config.maxDepth,
      crawl_id: this.crawlId,
    };
  }

  setProgressCallback(callback: (progress: CrawlProgress) => void) {
    this.progressCallback = callback;
  }

  stop() {
    this.shouldStop = true;
    this.logEvent('action', 'system', 'Crawler stop requested by user');
    
    // Stop recording if active
    if (this.isRecording) {
      this.stopRecording();
    }
    
    // Clear the queue to stop processing new URLs
    this.urlQueue.clear();
    
    // Pause the queue to prevent further processing
    this.urlQueue.pause();
    
    // Stop live streaming
    if (this.liveStreamInterval) {
      clearInterval(this.liveStreamInterval);
      this.liveStreamInterval = null;
    }
    
    // Close current page if exists
    if (this.currentPage) {
      this.currentPage.close().catch(() => {});
      this.currentPage = null;
    }
    
    // Clean up browser
    this.browserManager.cleanup().catch(() => {});
    
    this.logEvent('action', 'system', 'Crawler stopped and cleaned up');
  }

  async startRecording(startUrl: string) {
    if (this.isRecording) {
      this.stopRecording();
    }
    
    this.isRecording = true;
    this.recordingSession = {
      id: uuidv4(),
      start_time: new Date().toISOString(),
      start_url: startUrl,
      actions: [],
      screenshots: [],
      modals: []
    };
    this.recordedActions = [];
    
    // Create live browser session with debug overlay
    try {
      this.browserSession = new LiveBrowserSession();
      const sessionInfo = await this.browserSession.startLiveSession(startUrl);
      console.log(`[Recording] Live browser session started: ${sessionInfo.sessionId}`);
    } catch (error) {
      console.error('[Recording] Failed to start live browser session:', error);
    }
    
    this.logEvent('action', startUrl, '🎬 Recording started - all interactions will be captured');
  }

  async stopRecording(): Promise<RecordingSession | null> {
    if (!this.isRecording || !this.recordingSession) {
      return null;
    }
    
    this.isRecording = false;
    this.recordingSession.end_time = new Date().toISOString();
    this.recordingSession.actions = [...this.recordedActions];
    
    // Get data from live browser session if it exists
    if (this.browserSession) {
      try {
        const browserSessionData = await this.browserSession.stopLiveSession();
        if (browserSessionData) {
          // Merge browser session data with our recording session
          this.recordingSession.actions = [...this.recordingSession.actions, ...(browserSessionData.actions || [])];
          this.recordingSession.screenshots = [...(this.recordingSession.screenshots || []), ...(browserSessionData.screenshots || [])];
          this.recordingSession.modals = [...(this.recordingSession.modals || []), ...(browserSessionData.modals || [])];
        }
        
        // Clean up browser session
        await this.browserSession.cleanup();
        this.browserSession = null;
      } catch (error) {
        console.error('[Recording] Error stopping browser session:', error);
      }
    }
    
    const session = { ...this.recordingSession };
    
    this.logEvent('action', 'system', `🎬 Recording stopped - captured ${this.recordedActions.length} actions`);
    
    // Save recording to file
    await this.saveRecordingSession(session);
    
    return session;
  }

  private async saveRecordingSession(session: RecordingSession) {
    try {
      const fs = require('fs/promises');
      const path = require('path');
      
      const recordingsDir = path.join(process.cwd(), 'recordings');
      await fs.mkdir(recordingsDir, { recursive: true });
      
      const filename = `recording_${session.id}_${Date.now()}.json`;
      const filepath = path.join(recordingsDir, filename);
      
      await fs.writeFile(filepath, JSON.stringify(session, null, 2));
      
      this.logEvent('action', 'system', `Recording saved: ${filename}`);
    } catch (error) {
      this.logEvent('error', 'system', 'Failed to save recording session', {
        error_details: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private recordAction(action: Omit<RecordedAction, 'id' | 'timestamp'>) {
    if (!this.isRecording) return;
    
    const recordedAction: RecordedAction = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      ...action
    };
    
    this.recordedActions.push(recordedAction);
    
    this.logEvent('action', action.from_url, `🎬 Recorded: ${action.actions?.[0]?.action_description || 'Unknown action'}`, {
      element_selector: action.element_selector,
      element_text: action.element_text
    });
  }

  private async getElementSelector(element: any): Promise<string> {
    try {
      return await element.evaluate((el: Element) => {
        if (el.id) return `#${el.id}`;
        if (el.className) {
          const classes = el.className.split(' ').filter(c => c.trim()).join('.');
          if (classes) return `${el.tagName.toLowerCase()}.${classes}`;
        }
        return el.tagName.toLowerCase();
      });
    } catch (error) {
      return 'unknown';
    }
  }

  private logEvent(
    type: CrawlEvent['type'], 
    url: string, 
    message: string, 
    details?: CrawlEvent['details']
  ) {
    const event: CrawlEvent = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      type,
      url,
      message,
      details
    };
    this.events.push(event);
    console.log(`[${type.toUpperCase()}] ${message}`, details);
  }

  private logBrowserAction(
    type: BrowserAction['type'],
    url: string,
    options?: {
      position?: { x: number; y: number };
      element_selector?: string;
      element_text?: string;
      input_text?: string;
      scroll_amount?: number;
    }
  ) {
    const action: BrowserAction = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      type,
      url,
      ...options
    };
    this.browserActions.push(action);
    
    // Keep only last 20 actions to prevent memory issues
    if (this.browserActions.length > 20) {
      this.browserActions = this.browserActions.slice(-20);
    }
  }

  private startLiveStreaming(page: Page) {
    // Stop any existing stream
    if (this.liveStreamInterval) {
      clearInterval(this.liveStreamInterval);
    }

    this.currentPage = page;
    
    // Only take an initial screenshot, no continuous screenshots
    this.takeInitialLiveScreenshot();
    
    // Keep the page reference for browser actions but no continuous screenshots
    this.logEvent('action', page.url(), 'Live browser session active - screenshots only on navigation');
  }
  
  private async takeInitialLiveScreenshot() {
    if (this.currentPage && !this.shouldStop) {
      try {
        const screenshotPath = await this.takeStreamScreenshot(this.currentPage);
        if (screenshotPath) {
          this.latestScreenshot = `/api/screenshots/${screenshotPath}`;
          // Update progress to show initial screenshot
          this.updateProgress(this.currentPage.url());
        }
      } catch (error) {
        console.log('Initial live screenshot failed:', error);
      }
    }
  }

  private async takeStreamScreenshot(page: Page): Promise<string | null> {
    try {
      // Use live_ prefix to distinguish from final screenshots
      const filename = `live_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.png`;
      const screenshotsDir = './screenshots';
      const path = `${screenshotsDir}/${filename}`;
      
      // Ensure screenshots directory exists
      const fs = require('fs/promises');
      await fs.mkdir(screenshotsDir, { recursive: true });
      
      // Add overlay with metadata before taking screenshot
      await this.addScreenshotOverlay(page, page.url());
      
      // Get the viewport size
      const viewport = page.viewportSize() || { width: 1200, height: 800 };
      
      await page.screenshot({
        path,
        fullPage: false, // Only visible area for live view
        clip: { x: 0, y: 0, width: viewport.width, height: viewport.height }
      });
      
      // Remove overlay after screenshot
      await this.removeScreenshotOverlay(page);
      
      // Log live screenshot separately from final screenshots
      console.log(`Live screenshot taken: ${filename}`);
      
      return filename;
    } catch (error) {
      console.log('Live screenshot failed:', error);
      return null;
    }
  }

  private async takeRecordedScreenshot(page: Page, action: string): Promise<string | null> {
    try {
      // Use recorded_ prefix for recording screenshots
      const filename = `recorded_${Date.now()}_${action}_${Math.random().toString(36).substr(2, 9)}.png`;
      const screenshotsDir = './screenshots';
      const path = `${screenshotsDir}/${filename}`;
      
      // Ensure screenshots directory exists
      const fs = require('fs/promises');
      await fs.mkdir(screenshotsDir, { recursive: true });
      
      // Add overlay with metadata before taking screenshot
      await this.addScreenshotOverlay(page, page.url());
      
      await page.screenshot({
        path,
        fullPage: true // Full page for recording
      });
      
      // Remove overlay after screenshot
      await this.removeScreenshotOverlay(page);
      
      // Add to recording session if active
      if (this.isRecording && this.recordingSession) {
        this.recordingSession.screenshots.push(filename);
      }
      
      this.logEvent('screenshot', page.url(), `🎬 Recorded screenshot: ${action}`, {
        screenshot_path: filename
      });
      
      return filename;
    } catch (error) {
      console.log('Recorded screenshot failed:', error);
      return null;
    }
  }

  private updateProgress(currentUrl: string) {
    if (this.progressCallback) {
      const progress: CrawlProgress = {
        current_url: currentUrl,
        pages_discovered: this.visitedUrls.size,
        pages_crawled: this.pages.length,
        success_rate: this.metadata.total_pages > 0 
          ? (this.metadata.successful_crawls / this.metadata.total_pages) * 100 
          : 0,
        elapsed_time: Date.now() - new Date(this.metadata.start_time).getTime(),
        status: 'crawling',
        events: [...this.events], // Include event log in progress updates
        browser_actions: [...this.browserActions], // Include browser actions
        latest_screenshot: this.latestScreenshot || undefined // Include latest screenshot
      };
      this.progressCallback(progress);
    }
  }

  async start(): Promise<CrawlResult> {
    try {
      this.logEvent('action', this.config.startUrl, `Starting ${this.config.mode} mode crawler`, {
        dom_elements_found: 0
      });
      
      await this.browserManager.initialize();
      this.logEvent('action', this.config.startUrl, 'Browser initialized successfully');
      
      // Load robots.txt
      await this.loadRobotsTxt();
      
      // Start crawling from the initial URL
      await this.crawlPage(this.config.startUrl, null, 0, []);
      
      // Wait for all queued tasks to complete
      await this.urlQueue.onIdle();
      
      this.metadata.end_time = new Date().toISOString();
      
      if (this.progressCallback) {
        this.progressCallback({
          current_url: '',
          pages_discovered: this.visitedUrls.size,
          pages_crawled: this.pages.length,
          success_rate: (this.metadata.successful_crawls / this.metadata.total_pages) * 100,
          elapsed_time: Date.now() - new Date(this.metadata.start_time).getTime(),
          status: 'completed'
        });
      }

      return this.generateResult();
    } catch (error) {
      console.error('Crawler error:', error);
      throw error;
    } finally {
      // Stop live streaming
      if (this.liveStreamInterval) {
        clearInterval(this.liveStreamInterval);
        this.liveStreamInterval = null;
      }
      await this.browserManager.cleanup();
    }
  }

  private async loadRobotsTxt() {
    try {
      const url = new URL(this.config.startUrl);
      const robotsUrl = `${url.protocol}//${url.hostname}/robots.txt`;
      
      const page = await this.browserManager.createPage();
      const response = await page.goto(robotsUrl);
      
      if (response && response.ok()) {
        const content = await response.text();
        this.robotsTxt = robotsParser(robotsUrl, content);
      }
      
      await page.close();
    } catch (error) {
      console.log('Could not load robots.txt:', error);
    }
  }

  private canCrawlUrl(url: string): boolean {
    if (!this.robotsTxt) return true;
    
    return this.robotsTxt.isAllowed(url, 'Googlebot');
  }

  private normalizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      // Remove fragment
      parsed.hash = '';
      // Sort query parameters
      parsed.searchParams.sort();
      // Remove trailing slash
      let normalized = parsed.toString();
      if (normalized.endsWith('/') && parsed.pathname !== '/') {
        normalized = normalized.slice(0, -1);
      }
      return normalized;
    } catch {
      return url;
    }
  }

  private isWithinDomain(url: string): boolean {
    try {
      const startDomain = new URL(this.config.startUrl).hostname;
      const urlDomain = new URL(url).hostname;
      
      if (!this.config.domainRestrictions) return true;
      
      if (this.config.domainRestrictions.stayWithinDomain) {
        if (this.config.domainRestrictions.includeSubdomains) {
          return urlDomain.endsWith(startDomain);
        }
        return urlDomain === startDomain;
      }
      
      return true;
    } catch {
      return false;
    }
  }

  private async crawlPage(
    url: string, 
    parentUrl: string | null, 
    depth: number,
    discoveryPath: string[],
    discoveredVia?: { selector: string; link_text: string; element_type: string }
  ): Promise<void> {
    // Check if stop was requested
    if (this.shouldStop) {
      this.logEvent('action', url, 'Crawling stopped by user request');
      return;
    }

    const normalizedUrl = this.normalizeUrl(url);
    
    // Check if we've already visited this URL or if it exceeds max depth
    if (this.visitedUrls.has(normalizedUrl) || depth > this.config.maxDepth) {
      return;
    }
    
    // Check domain restrictions
    if (!this.isWithinDomain(url)) {
      return;
    }
    
    // Check robots.txt
    if (!this.canCrawlUrl(url)) {
      console.log(`Skipping ${url} due to robots.txt`);
      return;
    }
    
    this.visitedUrls.add(normalizedUrl);
    this.updateProgress(url);
    
    await this.urlQueue.add(async () => {
      const page = await this.browserManager.createPage();
      const startTime = Date.now();
      
      try {
        // Apply custom headers if provided
        if (this.config.customHeaders) {
          await page.setExtraHTTPHeaders(this.config.customHeaders);
        }
        
        this.logEvent('navigation', url, `Navigating to page (depth: ${depth})`);
        this.logBrowserAction('navigate', url);
        
        // Navigate to the page with improved load strategy
        const response = await page.goto(url, { 
          waitUntil: 'domcontentloaded', // Changed from 'networkidle' to 'domcontentloaded'
          timeout: 60000 // Increased timeout to 60 seconds
        });
        
        if (!response) {
          throw new Error('No response received');
        }
        
        this.logEvent('navigation', url, `Page loaded successfully (status: ${response.status()})`);
        
        // Mark this URL as successfully loaded (screenshot will be taken later)
        this.logEvent('action', url, 'Page successfully loaded and ready for processing');
        
        // Start live streaming for immediate browser preview
        this.startLiveStreaming(page);
        this.logEvent('action', url, 'Live browser session started for immediate preview');
        
        // Take screenshot immediately after successful navigation
        const initialScreenshot = await this.takeScreenshot(page, url);
        if (initialScreenshot) {
          this.latestScreenshot = `/api/screenshots/${initialScreenshot}`;
          this.screenshotTaken.add(url);
          this.updateProgress(url);
          this.logEvent('screenshot', url, 'Navigation screenshot captured');
        }
        
        // Record navigation if recording is active
        if (this.isRecording) {
          const recordedScreenshot = await this.takeRecordedScreenshot(page, 'navigation');
          const previousUrl = this.currentPage ? this.currentPage.url() : url;
          this.recordAction({
            type: 'navigation',
            from_url: previousUrl,
            to_url: url,
            actions: [{
              action_description: `Navigated from ${previousUrl} to ${url}`,
              screenshot: recordedScreenshot || undefined
            }],
            screenshot_after: recordedScreenshot || undefined
          });
        }
        
        // Handle login if credentials are provided and login form is detected
        if (this.config.loginCredentials && depth === 0) {
          this.logEvent('login', url, 'Attempting to detect and handle login');
          await this.detectAndHandleLogin(page);
        }
        
        // Wait for dynamic content with better handling
        try {
          await page.waitForLoadState('networkidle', { timeout: 10000 });
        } catch {
          console.log(`Network idle timeout for ${url}, continuing anyway`);
        }
        
        // Additional wait for dynamic content
        await page.waitForTimeout(3000);
        
        // Simulate human behavior
        this.logBrowserAction('scroll', url, { scroll_amount: 300 });
        await this.browserManager.humanScroll(page);
        this.logBrowserAction('hover', url, { position: { x: 500, y: 400 } });
        await this.browserManager.humanMouseMove(page);
        
        // Extract page data based on mode
        const pageData = await this.extractPageData(
          page, 
          url, 
          response.status(), 
          depth, 
          parentUrl,
          discoveryPath,
          discoveredVia,
          Date.now() - startTime
        );
        
        this.logEvent('action', url, `Extracted page data in ${this.config.mode} mode`, {
          dom_elements_found: pageData.technical_data.dom_elements_count
        });
        
        this.pages.push(pageData);
        this.metadata.total_pages++;
        this.metadata.successful_crawls++;
        
        // Extract and queue links
        const links = await this.extractLinks(page, url);
        
        this.logEvent('dom_detection', url, `Found ${links.length} links on page`, {
          links_discovered: links.length,
          dom_elements_found: links.length
        });
        
        // Apply sample mode filter if enabled
        const linksToProcess = this.config.sampleMode ? links.slice(0, 1) : links;
        
        if (this.config.sampleMode && links.length > 1) {
          this.logEvent('action', url, `Sample mode enabled: processing only 1 of ${links.length} links`);
        }
        
        for (const link of linksToProcess) {
          const newDiscoveryPath = [...discoveryPath, url];
          this.linkRelationships.push(link.relationship);
          
          this.logEvent('navigation', url, `🚀 QUEUING PAGE FOR CRAWLING: ${link.url}`, {
            links_discovered: 1,
            element_type: link.relationship.element_type,
            element_text: link.relationship.label?.substring(0, 50)
          });
          
          // Queue the new URL for crawling
          await this.crawlPage(
            link.url, 
            url, 
            depth + 1, 
            newDiscoveryPath,
            {
              selector: link.relationship.selector,
              link_text: link.relationship.label,
              element_type: link.relationship.element_type
            }
          );
        }
        
        // Screenshot was already taken immediately after navigation
        this.logEvent('action', url, 'Page processing completed - screenshot already captured');
        
      } catch (error) {
        console.error(`Error crawling ${url}:`, error);
        this.metadata.total_pages++;
        this.metadata.failed_crawls++;
        
        this.errors.push({
          url,
          error_type: this.categorizeError(error),
          error_message: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
          retry_attempts: 0
        });
      } finally {
        await page.close();
      }
    });
  }

  private async detectAndHandleLogin(page: Page) {
    try {
      this.logEvent('login', page.url(), 'Starting login detection process');
      
      // First, try to detect login buttons that lead to login pages
      const loginButtonFound = await this.detectAndClickLoginButton(page);
      
      if (loginButtonFound) {
        // Wait for navigation to login page
        await page.waitForTimeout(3000);
        this.logEvent('login', page.url(), 'Waiting for login page to load after button click');
      }
      
      // Now try to handle the actual login form
      await this.handleLoginForm(page);
      
    } catch (error) {
      this.logEvent('error', page.url(), 'Login detection failed', {
        error_details: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async detectAndClickLoginButton(page: Page): Promise<boolean> {
    try {
      this.logEvent('login', page.url(), '🔎 STARTING LOGIN BUTTON DETECTION', {
        dom_elements_found: 0
      });
      
      // Wait for page to be fully loaded
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(3000); // Give more time for dynamic content to load
      
      // First, get page title and check if we're already on a login page
      const pageTitle = await page.title();
      const pageUrl = page.url();
      this.logEvent('login', page.url(), `🔍 PAGE ANALYSIS: Title="${pageTitle}", URL="${pageUrl}"`);
      
      // Get all potentially clickable elements with expanded selectors (including Skool-specific patterns)
      const allClickableElements = await page.$$('button, a, [role="button"], input[type="submit"], input[type="button"], div[onclick], span[onclick], [class*="button"], [class*="btn"], [class*="Button"], [class*="Sign"]');
      
      this.logEvent('login', page.url(), `📊 FOUND ${allClickableElements.length} CLICKABLE ELEMENTS`, {
        dom_elements_found: allClickableElements.length
      });
      
      // Store all clickable elements for JSON output
      const clickableElementsData: any[] = [];
      
      // Log all elements for debugging
      let elementIndex = 0;
      for (const element of allClickableElements) {
        try {
          elementIndex++;
          const textContent = await element.textContent() || '';
          const innerHTML = await element.innerHTML() || '';
          const innerText = await element.innerText() || ''; // This gets the visible text including from child elements
          const tagName = await element.evaluate(el => el.tagName.toLowerCase());
          const className = await element.getAttribute('class') || '';
          const id = await element.getAttribute('id') || '';
          const href = await element.getAttribute('href') || '';
          const role = await element.getAttribute('role') || '';
          const ariaLabel = await element.getAttribute('aria-label') || '';
          const dataTestId = await element.getAttribute('data-testid') || '';
          const isVisible = await element.isVisible();
          
          // Get all child element text for nested content (like <button><span>Log In</span></button>)
          const allChildText = await element.evaluate(el => {
            const getAllText = (node: Element): string => {
              let text = '';
              for (const child of node.children) {
                text += ' ' + child.textContent + ' ' + getAllText(child);
              }
              return text;
            };
            return (el.textContent || '') + ' ' + getAllText(el);
          });
          
          // Store element data for JSON output
          const elementData = {
            index: elementIndex,
            tagName,
            textContent: textContent.trim(),
            innerText: innerText.trim(),
            className,
            id,
            href,
            isVisible,
            hasLogInText: [textContent, innerText, allChildText].some(text => 
              text.toLowerCase().includes('log in') || 
              text.toLowerCase().includes('login')
            ),
            hasSkoolClass: className.includes('SignUpButtonDesktop') || className.includes('ButtonWrapper')
          };
          clickableElementsData.push(elementData);
          
          // Log each clickable element in the event log
          this.logEvent('dom_detection', page.url(), `📝 Element ${elementIndex}/${allClickableElements.length}: ${tagName.toUpperCase()}`, {
            element_type: tagName,
            element_text: textContent.trim(),
            element_inner_text: innerText.trim(),
            element_class: className.substring(0, 50),
            element_id: id,
            is_visible: isVisible,
            has_login_text: elementData.hasLogInText,
            has_skool_class: elementData.hasSkoolClass
          });
          
          // Log ALL buttons and elements containing "log" for debugging
          if (tagName === 'button' || textContent.toLowerCase().includes('log') || innerText.toLowerCase().includes('log')) {
            this.logEvent('login', page.url(), `🔍 BUTTON ANALYSIS ${elementIndex}/${allClickableElements.length}: ${tagName.toUpperCase()}`, {
              element_type: tagName,
              element_text: textContent.trim(),
              element_inner_text: innerText.trim(),
              element_all_child_text: allChildText.trim(),
              element_class: className.substring(0, 100),
              element_id: id,
              element_href: href,
              is_visible: isVisible
            });
            
            // Specifically check for "Log In" patterns and Skool-specific classes
            const hasLogIn = [textContent, innerText, allChildText].some(text => 
              text.toLowerCase().includes('log in') || 
              text.toLowerCase().includes('login')
            );
            
            const hasSkoolLoginClass = className.includes('SignUpButtonDesktop') || 
                                      className.includes('ButtonWrapper');
            
            if (hasLogIn || hasSkoolLoginClass) {
              this.logEvent('login', page.url(), `🚨 POTENTIAL LOGIN BUTTON FOUND: "${innerText.trim() || textContent.trim()}"`, {
                element_type: tagName,
                element_text: textContent.trim(),
                element_inner_text: innerText.trim(),
                element_class: className,
                is_visible: isVisible,
                has_login_text: hasLogIn,
                has_skool_class: hasSkoolLoginClass
              });
            }
          }
          
          // Convert all possible text sources to lowercase for accurate comparison
          const allTextSources = [textContent, innerHTML, innerText, allChildText, className, id, href, role, ariaLabel, dataTestId];
          const allTextLower = allTextSources.join(' ').toLowerCase();
          
          // Check multiple text sources (including nested content)
          const textContentLower = textContent.toLowerCase().trim();
          const innerTextLower = innerText.toLowerCase().trim();
          const allChildTextLower = allChildText.toLowerCase().trim();
          
          // Comprehensive login text patterns (using lowercase)
          const loginTexts = [
            'log in', 'login', 'log-in', 
            'sign in', 'signin', 'sign-in',
            'enter', 'access', 'member login',
            'authenticate', 'auth'
          ];
          
          // Check if any login text appears in ANY of the text sources
          const hasLoginText = loginTexts.some(loginText => 
            textContentLower.includes(loginText) || 
            innerTextLower.includes(loginText) ||
            allChildTextLower.includes(loginText) ||
            allTextLower.includes(loginText)
          );
          
          // Also check with regex patterns for word boundaries
          const loginPatterns = [
            /\blog\s*in\b/,
            /\blogin\b/, 
            /\bsign\s*in\b/,
            /\bsignin\b/,
            /\benter\b/,
            /\bauth\b/,
            /\baccess\b/,
            /\bmember\b/
          ];
          
          const hasLoginPattern = loginPatterns.some(pattern => pattern.test(allTextLower));
          
          const isLoginElement = hasLoginText || hasLoginPattern;
            
          if (isLoginElement) {
            // Find which pattern matched and from which text source
            const matchedText = loginTexts.find(loginText => 
              textContentLower.includes(loginText) || 
              innerTextLower.includes(loginText) ||
              allChildTextLower.includes(loginText) ||
              allTextLower.includes(loginText)
            );
            const matchedPattern = loginPatterns.find(pattern => pattern.test(allTextLower));
            
            // Determine which text source had the match
            let matchedIn = 'unknown';
            if (matchedText) {
              if (textContentLower.includes(matchedText)) matchedIn = 'textContent';
              else if (innerTextLower.includes(matchedText)) matchedIn = 'innerText';  
              else if (allChildTextLower.includes(matchedText)) matchedIn = 'childText';
              else if (allTextLower.includes(matchedText)) matchedIn = 'combined';
            }
            
            this.logEvent('dom_detection', page.url(), `🎯 FOUND LOGIN ELEMENT: ${tagName} with "${innerText.trim() || textContent.trim()}"`, {
              element_text: textContent.trim(),
              element_inner_text: innerText.trim(),
              element_all_child_text: allChildText.trim(),
              element_class: className,
              element_id: id,
              element_href: href,
              is_visible: isVisible,
              matched_text: matchedText || 'pattern match',
              matched_in: matchedIn,
              matched_pattern: matchedPattern?.toString() || 'none'
            });
            
            if (isVisible) {
              this.logEvent('login', page.url(), `Attempting to click login element: "${textContent.trim()}"`, {
                element_type: tagName,
                element_text: textContent.trim(),
                element_class: className
              });
              
              // Get element position for browser action logging
              const boundingBox = await element.boundingBox();
              if (boundingBox) {
                this.logBrowserAction('click', page.url(), {
                  position: { x: boundingBox.x + boundingBox.width / 2, y: boundingBox.y + boundingBox.height / 2 },
                  element_text: textContent.trim()
                });
              }
              
              // Record click action if recording
              let screenshotBefore = null;
              if (this.isRecording) {
                screenshotBefore = await this.takeRecordedScreenshot(page, 'before_login_click');
              }
              
              // Click the login element with human-like behavior
              await this.browserManager.humanDelay(500, 1500);
              await this.browserManager.humanClick(page, element);
              await this.browserManager.humanDelay(1000, 3000);
              
              this.logEvent('login', page.url(), 'Login element clicked successfully');
              
              // Record click action if recording
              if (this.isRecording) {
                const screenshotAfter = await this.takeRecordedScreenshot(page, 'after_login_click');
                this.recordAction({
                  type: 'click',
                  from_url: page.url(),
                  to_url: page.url(),
                  actions: [{
                    action_description: `Clicked on login button: ${textContent.trim()}`,
                    screenshot: screenshotAfter || undefined
                  }],
                  position: boundingBox ? { 
                    x: boundingBox.x + boundingBox.width / 2, 
                    y: boundingBox.y + boundingBox.height / 2 
                  } : undefined,
                  element_selector: await this.getElementSelector(element),
                  element_text: textContent.trim(),
                  screenshot_before: screenshotBefore || undefined,
                  screenshot_after: screenshotAfter || undefined
                });
              }
              
              // Store clickable elements data for this URL before returning
              this.clickableElementsByUrl.set(page.url(), clickableElementsData);
              
              return true;
            }
          }
        } catch (error) {
          // Continue to next element if this one fails
          continue;
        }
      }
      
      // Fallback: Try comprehensive selectors if no elements found above
      const loginButtonSelectors = [
        // More specific selectors for common patterns
        'button:has-text("LOG IN")',
        'button:has-text("Log In")',  
        'button:has-text("log in")',
        'button:has-text("Login")',
        'button:has-text("LOGIN")',
        'a:has-text("LOG IN")',
        'a:has-text("Log In")',
        'a:has-text("log in")',
        'a:has-text("Login")',
        'a:has-text("LOGIN")',
        'button:has-text("Sign In")',
        'button:has-text("SIGN IN")',
        'button:has-text("sign in")',
        'a:has-text("Sign In")',
        'a:has-text("SIGN IN")',
        'a:has-text("sign in")',
        
        // Generic selectors
        'button[class*="login"]',
        'button[class*="signin"]', 
        'button[id*="login"]',
        'button[id*="signin"]',
        'a[class*="login"]',
        'a[class*="signin"]',
        'a[id*="login"]',
        'a[id*="signin"]',
        'a[href*="login"]',
        'a[href*="signin"]'
      ];
      
      this.logEvent('dom_detection', page.url(), `Scanning for login buttons with ${loginButtonSelectors.length} selectors`);
      
      // Try each selector to find a login button
      for (const selector of loginButtonSelectors) {
        try {
          const elements = await page.locator(selector);
          const count = await elements.count();
          
          if (count > 0) {
            const firstElement = elements.first();
            const elementText = await firstElement.textContent();
            const elementTag = await firstElement.evaluate(el => el.tagName.toLowerCase());
            const elementClass = await firstElement.getAttribute('class');
            const isVisible = await firstElement.isVisible();
            
            if (isVisible) {
              this.logEvent('dom_detection', page.url(), `Found login button: ${selector}`, {
                element_selector: selector,
                element_type: elementTag,
                element_text: elementText || '',
                dom_elements_found: count
              });
              
              // Log the click attempt
              this.logEvent('login', page.url(), `Clicking login button: "${elementText}"`, {
                element_selector: selector,
                element_type: elementTag,
                element_text: elementText || ''
              });
              
              // Click the login button with human-like behavior
              await this.browserManager.humanDelay(500, 1500);
              
              // Get element position for browser action logging
              const boundingBox = await firstElement.boundingBox();
              const position = boundingBox ? { 
                x: Math.round(boundingBox.x + boundingBox.width / 2), 
                y: Math.round(boundingBox.y + boundingBox.height / 2) 
              } : undefined;
              
              this.logBrowserAction('click', page.url(), {
                position,
                element_selector: selector,
                element_text: elementText || ''
              });
              
              await firstElement.click();
              
              this.logEvent('login', page.url(), 'Login button clicked successfully');
              return true;
            } else {
              this.logEvent('dom_detection', page.url(), `Login button found but not visible: ${selector}`);
            }
          }
        } catch (error) {
          // Continue to next selector if this one fails
          continue;
        }
      }
      
      // Store clickable elements data for this URL
      this.clickableElementsByUrl.set(page.url(), clickableElementsData);
      
      this.logEvent('login', page.url(), '❌ NO LOGIN BUTTONS DETECTED ON PAGE', {
        dom_elements_found: allClickableElements.length
      });
      return false;
      
    } catch (error) {
      this.logEvent('error', page.url(), 'Login button detection failed', {
        error_details: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  private async handleLoginForm(page: Page) {
    try {
      this.logEvent('login', page.url(), 'Scanning for login form fields');
      
      // Enhanced login selectors for better detection
      const usernameSelectors = [
        'input[name="username"]', 
        'input[name="email"]', 
        'input[type="email"]', 
        '#username', 
        '#email',
        'input[name="user"]',
        'input[name="login"]',
        'input[placeholder*="username"]',
        'input[placeholder*="email"]',
        'input[id*="username"]',
        'input[id*="email"]',
        'input[class*="username"]',
        'input[class*="email"]'
      ];
      
      const passwordSelectors = [
        'input[name="password"]', 
        'input[type="password"]', 
        '#password',
        'input[id*="password"]',
        'input[class*="password"]',
        'input[placeholder*="password"]'
      ];
      
      const submitSelectors = [
        'button[type="submit"]', 
        'input[type="submit"]', 
        'button:has-text("Login")', 
        'button:has-text("Sign in")',
        'button:has-text("Log in")',
        'button:has-text("Submit")',
        'button:has-text("Enter")',
        'button[class*="submit"]',
        'button[class*="login"]',
        'button[id*="submit"]',
        'button[id*="login"]'
      ];
      
      let usernameField, passwordField, submitButton;
      
      // Find username field with enhanced logging
      this.logEvent('dom_detection', page.url(), `Searching for username field with ${usernameSelectors.length} selectors`);
      for (const selector of usernameSelectors) {
        try {
          const elements = await page.locator(selector);
          const count = await elements.count();
          
          if (count > 0) {
            const isVisible = await elements.first().isVisible();
            if (isVisible) {
              usernameField = selector;
              this.logEvent('dom_detection', page.url(), `Found username field: ${selector}`, {
                element_selector: selector,
                element_type: 'input',
                dom_elements_found: count
              });
              break;
            }
          }
        } catch {
          continue;
        }
      }
      
      // Find password field with enhanced logging
      this.logEvent('dom_detection', page.url(), `Searching for password field with ${passwordSelectors.length} selectors`);
      for (const selector of passwordSelectors) {
        try {
          const elements = await page.locator(selector);
          const count = await elements.count();
          
          if (count > 0) {
            const isVisible = await elements.first().isVisible();
            if (isVisible) {
              passwordField = selector;
              this.logEvent('dom_detection', page.url(), `Found password field: ${selector}`, {
                element_selector: selector,
                element_type: 'input',
                dom_elements_found: count
              });
              break;
            }
          }
        } catch {
          continue;
        }
      }
      
      // Find submit button with enhanced logging
      this.logEvent('dom_detection', page.url(), `Searching for submit button with ${submitSelectors.length} selectors`);
      for (const selector of submitSelectors) {
        try {
          const elements = await page.locator(selector);
          const count = await elements.count();
          
          if (count > 0) {
            const isVisible = await elements.first().isVisible();
            if (isVisible) {
              submitButton = selector;
              const buttonText = await elements.first().textContent();
              this.logEvent('dom_detection', page.url(), `Found submit button: ${selector}`, {
                element_selector: selector,
                element_type: 'button',
                element_text: buttonText || '',
                dom_elements_found: count
              });
              break;
            }
          }
        } catch {
          continue;
        }
      }
      
      // Attempt to fill and submit the form
      if (usernameField && passwordField && submitButton && this.config.loginCredentials) {
        this.logEvent('login', page.url(), 'Complete login form detected, proceeding with authentication', {
          form_fields: [usernameField, passwordField, submitButton]
        });
        
        // Fill username field
        this.logEvent('login', page.url(), 'Filling username field');
        this.logBrowserAction('type', page.url(), {
          element_selector: usernameField,
          input_text: this.config.loginCredentials.username
        });
        await this.browserManager.humanType(page, usernameField, this.config.loginCredentials.username);
        await this.browserManager.humanDelay();
        
        // Fill password field
        this.logEvent('login', page.url(), 'Filling password field');
        this.logBrowserAction('type', page.url(), {
          element_selector: passwordField,
          input_text: '••••••••' // Don't log actual password
        });
        await this.browserManager.humanType(page, passwordField, this.config.loginCredentials.password);
        await this.browserManager.humanDelay();
        
        // Submit the form
        this.logEvent('login', page.url(), 'Submitting login form');
        this.logBrowserAction('click', page.url(), {
          element_selector: submitButton
        });
        await page.locator(submitButton).click();
        
        this.logEvent('login', page.url(), 'Login form submitted successfully, waiting for response');
        await page.waitForTimeout(5000); // Wait longer for login response
        
        // Check if login was successful by looking for common success indicators
        await this.checkLoginSuccess(page);
        
      } else {
        const missingFields = [];
        if (!usernameField) missingFields.push('username');
        if (!passwordField) missingFields.push('password');
        if (!submitButton) missingFields.push('submit button');
        
        this.logEvent('login', page.url(), `Login form incomplete - missing: ${missingFields.join(', ')}`);
      }
    } catch (error) {
      this.logEvent('error', page.url(), 'Login form handling failed', {
        error_details: error instanceof Error ? error.message : String(error)
      });
    }
  }
  
  private async checkLoginSuccess(page: Page) {
    try {
      // Common indicators of successful login
      const successIndicators = [
        'button:has-text("Logout")',
        'button:has-text("Sign out")',
        'a:has-text("Logout")',
        'a:has-text("Sign out")',
        '[class*="dashboard"]',
        '[class*="profile"]',
        '[data-testid*="user-menu"]',
        '[aria-label*="user menu"]'
      ];
      
      // Check for error messages
      const errorIndicators = [
        '.error',
        '.alert-error',
        '[class*="error"]',
        'text=Invalid credentials',
        'text=Login failed',
        'text=Incorrect password',
        'text=User not found'
      ];
      
      // Check for success indicators
      for (const selector of successIndicators) {
        try {
          const elements = await page.locator(selector);
          if (await elements.count() > 0) {
            this.logEvent('login', page.url(), 'Login appears successful - found success indicator', {
              element_selector: selector
            });
            return;
          }
        } catch {
          continue;
        }
      }
      
      // Check for error indicators
      for (const selector of errorIndicators) {
        try {
          const elements = await page.locator(selector);
          if (await elements.count() > 0) {
            const errorText = await elements.first().textContent();
            this.logEvent('error', page.url(), 'Login failed - found error indicator', {
              element_selector: selector,
              error_details: errorText || 'Unknown error'
            });
            return;
          }
        } catch {
          continue;
        }
      }
      
      this.logEvent('login', page.url(), 'Login status unclear - no clear success or error indicators found');
      
    } catch (error) {
      this.logEvent('error', page.url(), 'Could not determine login status', {
        error_details: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async extractPageData(
    page: Page,
    url: string,
    statusCode: number,
    depth: number,
    parentUrl: string | null,
    discoveryPath: string[],
    discoveredVia: { selector: string; link_text: string; element_type: string } | undefined,
    loadTime: number
  ): Promise<PageData> {
    const data = await page.evaluate((mode) => {
      const getText = (selector: string) => {
        const element = document.querySelector(selector);
        return element?.textContent?.trim() || '';
      };
      
      const getHeadings = () => {
        const headings: string[] = [];
        document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(h => {
          const text = h.textContent?.trim();
          if (text) headings.push(text);
        });
        return headings;
      };
      
      const getLinks = () => {
        const internal: string[] = [];
        const external: string[] = [];
        const currentDomain = window.location.hostname;
        
        // Include anchor tags
        document.querySelectorAll('a[href]').forEach(link => {
          const href = (link as HTMLAnchorElement).href;
          try {
            const url = new URL(href);
            if (url.hostname === currentDomain) {
              internal.push(href);
            } else {
              external.push(href);
            }
          } catch {}
        });
        
        // Include clickable elements that might navigate (buttons, divs, etc. with onclick that contain URLs)
        document.querySelectorAll('button[onclick], div[onclick], span[onclick], [data-href], [data-url]').forEach(element => {
          // Check onclick attribute for URLs
          const onclick = element.getAttribute('onclick') || '';
          const dataHref = element.getAttribute('data-href') || '';
          const dataUrl = element.getAttribute('data-url') || '';
          
          [onclick, dataHref, dataUrl].forEach(attr => {
            // Extract URLs from onclick handlers or data attributes
            const urlMatches = attr.match(/(?:https?:\/\/|\/)[^\s"'`)]+/g);
            if (urlMatches) {
              urlMatches.forEach(match => {
                try {
                  const url = new URL(match, window.location.origin);
                  if (url.hostname === currentDomain) {
                    if (!internal.includes(url.href)) internal.push(url.href);
                  } else {
                    if (!external.includes(url.href)) external.push(url.href);
                  }
                } catch {}
              });
            }
          });
        });
        
        return { internal, external };
      };
      
      const getImages = () => {
        const images: Array<{ src: string; alt: string }> = [];
        document.querySelectorAll('img').forEach(img => {
          if (img.src) {
            images.push({
              src: img.src,
              alt: img.alt || ''
            });
          }
        });
        return images;
      };
      
      const getForms = () => {
        const forms: Array<{ action: string; method: string; fields: string[] }> = [];
        document.querySelectorAll('form').forEach(form => {
          const fields: string[] = [];
          form.querySelectorAll('input, textarea, select').forEach(field => {
            const name = (field as HTMLInputElement).name;
            if (name) fields.push(name);
          });
          
          forms.push({
            action: form.action || '',
            method: form.method || 'get',
            fields
          });
        });
        return forms;
      };
      
      // Different data extraction based on mode
      if (mode === 'crawl') {
        // Crawl mode: only extract navigation structure and basic info
        return {
          title: document.title || '',
          meta_description: getText('meta[name="description"]'),
          text_content: '', // Don't extract full text content in crawl mode
          headings: getHeadings().slice(0, 3), // Only top 3 headings
          links: getLinks(),
          images: [], // Don't extract images in crawl mode
          forms: getForms(),
          dom_elements_count: document.querySelectorAll('*').length,
          page_size: new Blob([document.documentElement.outerHTML]).size
        };
      } else {
        // Scrape mode: extract full content
        return {
          title: document.title || '',
          meta_description: getText('meta[name="description"]'),
          text_content: document.body?.innerText || '',
          headings: getHeadings(),
          links: getLinks(),
          images: getImages(),
          forms: getForms(),
          dom_elements_count: document.querySelectorAll('*').length,
          page_size: new Blob([document.documentElement.outerHTML]).size
        };
      }
    }, this.config.mode);
    
    return {
      url,
      title: data.title,
      meta_description: data.meta_description,
      status_code: statusCode,
      depth,
      parent_url: parentUrl,
      discovery_path: discoveryPath,
      discovered_via: discoveredVia || null,
      crawl_timestamp: new Date().toISOString(),
      load_time: loadTime,
      content: {
        text_content: data.text_content.substring(0, 5000), // Limit text content
        headings: data.headings,
        links: data.links,
        images: data.images,
        forms: data.forms,
        clickable_elements: this.clickableElementsByUrl.get(url) || []
      },
      technical_data: {
        response_headers: {},
        page_size: data.page_size,
        dom_elements_count: data.dom_elements_count,
        javascript_errors: [],
        console_logs: []
      }
    };
  }

  private async extractLinks(page: Page, currentUrl: string): Promise<Array<{ url: string; relationship: LinkRelationship }>> {
    const followTags = this.config.followLinkTags || ['a', 'button']; // Default to anchor tags and buttons
    
    const links = await page.evaluate((params) => {
      const { currentUrl, followTags } = params as { currentUrl: string; followTags: string[] };
      const results: Array<{ 
        url: string; 
        label: string; 
        selector: string; 
        element_type: string;
        position: { x: number; y: number };
      }> = [];
      
      // Helper to generate CSS selector
      const getSelector = (element: Element): string => {
        if (element.id) return `#${element.id}`;
        if (element.className) {
          const classes = element.className.split(' ').filter(c => c).join('.');
          if (classes) return `${element.tagName.toLowerCase()}.${classes}`;
        }
        return element.tagName.toLowerCase();
      };
      
      // Extract links from anchor tags (if enabled)
      if (followTags.includes('a')) {
        document.querySelectorAll('a[href]').forEach((link) => {
          const anchor = link as HTMLAnchorElement;
          const rect = anchor.getBoundingClientRect();
          
          try {
            const url = new URL(anchor.href, currentUrl);
            results.push({
              url: url.href,
              label: anchor.textContent?.trim() || anchor.title || '',
              selector: getSelector(anchor),
              element_type: 'anchor',
              position: { x: Math.round(rect.x), y: Math.round(rect.y) }
            });
          } catch {}
        });
      }
      
      // Extract links from buttons with onclick (if enabled)
      if (followTags.includes('button')) {
        document.querySelectorAll('button[onclick]').forEach((button) => {
          const rect = button.getBoundingClientRect();
          const onclick = button.getAttribute('onclick') || '';
          const urlMatch = onclick.match(/(?:location\.href|window\.location)\s*=\s*['"]([^'"]+)['"]/);
          
          if (urlMatch) {
            try {
              const url = new URL(urlMatch[1], currentUrl);
              results.push({
                url: url.href,
                label: button.textContent?.trim() || '',
                selector: getSelector(button),
                element_type: 'button',
                position: { x: Math.round(rect.x), y: Math.round(rect.y) }
              });
            } catch {}
          }
        });
      }
      
      return results;
    }, { currentUrl, followTags });
    
    return (links as Array<{ 
      url: string; 
      label: string; 
      selector: string; 
      element_type: string;
      position: { x: number; y: number };
    }>).map(link => ({
      url: link.url,
      relationship: {
        from: currentUrl,
        to: link.url,
        label: link.label,
        selector: link.selector,
        element_type: link.element_type,
        position: link.position,
        discovery_timestamp: new Date().toISOString()
      }
    }));
  }

  private async takeScreenshot(page: Page, url: string): Promise<string | null> {
    try {
      const filename = `screenshot_${Date.now()}_${url.replace(/[^a-z0-9]/gi, '_')}.png`;
      const screenshotsDir = './screenshots';
      const path = `${screenshotsDir}/${filename}`;
      
      // Ensure screenshots directory exists
      const fs = require('fs/promises');
      await fs.mkdir(screenshotsDir, { recursive: true });
      
      // Add overlay with metadata before taking screenshot
      await this.addScreenshotOverlay(page, url);
      
      await page.screenshot({
        path,
        fullPage: true
      });
      
      // Remove overlay after screenshot
      await this.removeScreenshotOverlay(page);
      
      // Update page data with screenshot info
      const pageData = this.pages.find(p => p.url === url);
      if (pageData) {
        pageData.screenshot = {
          filename,
          full_page: true,
          viewport: { width: 1920, height: 1080 }
        };
      }
      
      return filename;
    } catch (error) {
      this.logEvent('error', url, 'Screenshot capture failed', {
        error_details: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  private async addScreenshotOverlay(page: Page, url: string) {
    try {
      const breadcrumb = this.generateBreadcrumbTrail(url);
      const timestamp = new Date().toLocaleString();
      
      // Inject overlay HTML and CSS
      await page.evaluate((overlayData) => {
        // Remove existing overlay if present
        const existingOverlay = document.getElementById('crawler-screenshot-overlay');
        if (existingOverlay) {
          existingOverlay.remove();
        }
        
        // Create overlay
        const overlay = document.createElement('div');
        overlay.id = 'crawler-screenshot-overlay';
        overlay.style.cssText = `
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          padding: 12px 20px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 14px;
          line-height: 1.4;
          z-index: 999999;
          box-shadow: 0 2px 10px rgba(0,0,0,0.3);
          border-bottom: 2px solid rgba(255,255,255,0.2);
        `;
        
        overlay.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px;">
            <div style="flex: 1; min-width: 200px;">
              <div style="font-weight: 600; font-size: 16px; margin-bottom: 4px;">📸 Web Crawler Screenshot</div>
              <div style="font-size: 12px; opacity: 0.9;">🕒 ${overlayData.timestamp}</div>
            </div>
            <div style="flex: 2; min-width: 300px;">
              <div style="font-weight: 500; margin-bottom: 4px;">🗂️ ${overlayData.breadcrumb}</div>
              <div style="font-size: 12px; font-family: monospace; background: rgba(0,0,0,0.2); padding: 4px 8px; rounded: 4px; word-break: break-all;">
                🔗 ${overlayData.url}
              </div>
            </div>
          </div>
        `;
        
        document.body.insertBefore(overlay, document.body.firstChild);
        
        // Scroll to top to ensure overlay is visible
        window.scrollTo(0, 0);
      }, { timestamp, breadcrumb, url });
      
      // Wait a moment for the overlay to render
      await page.waitForTimeout(500);
    } catch (error) {
      console.log('Failed to add screenshot overlay:', error);
    }
  }

  private async removeScreenshotOverlay(page: Page) {
    try {
      await page.evaluate(() => {
        const overlay = document.getElementById('crawler-screenshot-overlay');
        if (overlay) {
          overlay.remove();
        }
      });
    } catch (error) {
      console.log('Failed to remove screenshot overlay:', error);
    }
  }

  private categorizeError(error: any): 'timeout' | '404' | 'javascript_error' | 'other' {
    if (error.message?.includes('timeout')) return 'timeout';
    if (error.message?.includes('404')) return '404';
    if (error.message?.includes('JavaScript')) return 'javascript_error';
    return 'other';
  }

  private generateResult(): CrawlResult {
    const domain = new URL(this.config.startUrl).hostname;
    
    // Build navigation paths
    const navigationPaths = this.buildNavigationPaths();
    
    return {
      crawl_metadata: this.metadata,
      site_structure: {
        domain,
        navigation_paths: navigationPaths,
        link_relationships: this.linkRelationships,
        sitemap: this.buildSitemap()
      },
      pages: this.pages,
      assets: {
        stylesheets: [],
        scripts: [],
        images: [],
        documents: []
      },
      errors: this.errors
    };
  }

  private buildNavigationPaths() {
    const paths: Array<{
      path: string;
      depth: number;
      parent: string | null;
      children: string[];
    }> = [];
    
    this.pages.forEach(page => {
      const children = this.pages
        .filter(p => p.parent_url === page.url)
        .map(p => p.url);
      
      paths.push({
        path: new URL(page.url).pathname,
        depth: page.depth,
        parent: page.parent_url,
        children
      });
    });
    
    return paths;
  }

  private buildSitemap() {
    // Simple tree structure for sitemap
    const root = {
      url: this.config.startUrl,
      children: [] as any[]
    };
    
    const buildTree = (node: any, depth: number) => {
      if (depth > this.config.maxDepth) return;
      
      const children = this.pages.filter(p => p.parent_url === node.url);
      node.children = children.map(child => ({
        url: child.url,
        title: child.title,
        children: []
      }));
      
      node.children.forEach((child: any) => buildTree(child, depth + 1));
    };
    
    buildTree(root, 0);
    return root;
  }
}