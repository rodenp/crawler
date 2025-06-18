import { Page, Browser } from 'playwright';
import { v4 as uuidv4 } from 'uuid';
import { BrowserManager } from '../crawler/browser-manager';
import { RecordedAction, RecordingSession, DiscoveredLink, DetectedModal, ModalStateChange } from '@/lib/types/crawler';
import fs from 'fs/promises';
import path from 'path';

export class LiveBrowserSession {
  private browserManager: BrowserManager;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private sessionId: string;
  private recordingSession: RecordingSession | null = null;
  private isRecording = false;
  private currentUrl: string = '';
  private screenshotIndex = 0;
  private wsPort: number;
  private lastAction: RecordedAction | null = null; // Track last action before navigation
  private modalScreenshotIndex = 0; // Track modal screenshots separately
  private modalCheckInterval: NodeJS.Timeout | null = null; // Modal detection interval
  private activeModal: DetectedModal | null = null; // Currently active modal
  private lastModalContent: string | null = null; // Track modal content for change detection
  private actionHistory: RecordedAction[] = []; // Track recent actions for correlation
  private mutationCheckInterval: NodeJS.Timeout | null = null; // Mutation observer polling
  private trackedModals: Map<string, any> = new Map(); // Track modals and their interactions
  private modalInteractionEnabled = false; // Flag to enable modal interaction tracking
  private isTrainingMode = false; // Flag to indicate if we're in training mode (no recordings)
  private currentSiteDomain = ''; // Current site domain for rule-based detection
  private lastModalScreenshotTime = 0; // Track last modal screenshot to prevent duplicates
  private lastModalId = ''; // Track last modal ID to prevent duplicate recordings

  constructor() {
    this.browserManager = new BrowserManager();
    this.sessionId = uuidv4();
    this.wsPort = 9222; // Chrome DevTools port
  }

  async startLiveSession(startUrl: string): Promise<{ sessionId: string; wsEndpoint: string }> {
    try {
      // Initialize browser with remote debugging (headless = false for live session)
      await this.browserManager.initialize(false);
      this.browser = this.browserManager.getBrowser();
      
      if (!this.browser) {
        throw new Error('Failed to initialize browser');
      }
      
      // Create new page for live session
      this.page = await this.browser.newPage();
      
      // Enable console log collection
      this.page.on('console', (msg) => {
        const text = msg.text();
        
        // Filter out common website warnings/errors that aren't relevant
        const shouldIgnore = text.includes('Deprecation warning: value provided is not in a recognized RFC2822') ||
                           text.includes('Unsupported prop change on Elements') ||
                           text.includes('moment construction falls back to js Date()') ||
                           text.includes('createFromInputFallback');
        
        if (!shouldIgnore) {
          // Log relevant browser console messages
          console.log(`[Browser Console] ${msg.type()}: ${text}`);
        }
        
        // Process specific modal-related events (removed verbose logging)
        this.processModalConsoleMessages(text);
      });
      
      // Setup recording if needed
      this.recordingSession = {
        id: this.sessionId,
        start_time: new Date().toISOString(),
        start_url: startUrl,
        actions: [],
        screenshots: [],
        modals: []
      };

      // Navigate to start URL
      await this.page.goto(startUrl);
      
      // Setup event listeners for recording
      await this.setupEventListeners();
      
      // Start modal detection
      this.startModalDetection();
      
      // Enable modal interaction tracking first
      this.enableModalInteractionTracking();
      
      // Then load and apply site-specific rules (this will trigger refreshComponentMonitoring)
      await this.loadAndApplySiteRules();
      
      // Final comprehensive monitoring setup
      await this.injectMonitoringScripts();
      
      // Wait for initial page to load
      await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {
        console.log('Initial page load timeout, continuing...');
      });
      
      // Update currentUrl to the actual URL after any redirects
      this.currentUrl = this.page.url();
      this.currentSiteDomain = new URL(this.currentUrl).hostname;
      console.log(`Initial page loaded. Expected: ${startUrl}, Actual: ${this.currentUrl}, Domain: ${this.currentSiteDomain}`);
      
      // Discover links on the initial page
      const discoveredLinks = await this.discoverLinks();
      
      // Record initial page load with discovered links
      await this.recordAction({
        type: 'navigation',
        from_url: '',
        to_url: this.currentUrl,
        actions: [{
          action_description: `Initial page load: ${this.currentUrl}`
        }],
        discovered_links: discoveredLinks
      });
      
      // Take initial screenshot and capture HTML
      await this.takeScreenshot('initial_load', true);
      
      // Inject persistent debug overlay into the browser page
      await this.injectPersistentDebugOverlay();
      
      // Verify overlay was injected successfully
      try {
        await this.page.waitForSelector('#crawler-debug-overlay', { timeout: 3000 });
        console.log(`[Debug Overlay] Overlay successfully injected and verified`);
      } catch (error) {
        console.log('[Debug Overlay] Overlay not found after injection, will fallback to direct injection');
        await this.injectDebugOverlayDirect();
      }
      
      this.isRecording = true;
      
      // For live browser session, we'll use the debug port instead of wsEndpoint
      const debugPort = 9222;
      
      console.log(`Live browser session started: ${this.sessionId}`);
      console.log(`Debug port: ${debugPort}`);
      
      return {
        sessionId: this.sessionId,
        wsEndpoint: `ws://localhost:${debugPort}/devtools/browser`
      };
      
    } catch (error) {
      console.error('Failed to start live browser session:', error);
      throw error;
    }
  }

  async stopLiveSession(): Promise<RecordingSession | null> {
    if (!this.isRecording || !this.recordingSession) {
      return null;
    }

    this.recordingSession.end_time = new Date().toISOString();
    
    // Stop recording first to prevent new captures
    this.isRecording = false;

    // Stop modal detection
    if (this.modalCheckInterval) {
      clearInterval(this.modalCheckInterval);
      this.modalCheckInterval = null;
    }
    if (this.mutationCheckInterval) {
      clearInterval(this.mutationCheckInterval);
      this.mutationCheckInterval = null;
    }

    // Save recording session
    await this.saveRecordingSession();
    
    // Give a small delay to allow any ongoing HTML capture to complete or abort gracefully
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Close page and browser window
    if (this.page) {
      await this.page.close();
      this.page = null;
    }
    
    // Close the entire browser to close the window
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    
    // Also cleanup browser manager
    await this.browserManager.cleanup();
    
    const session = this.recordingSession;
    this.recordingSession = null;
    
    console.log(`Live browser session stopped and browser window closed: ${session.id}`);
    return session;
  }

  private async setupEventListeners() {
    if (!this.page) return;

    // Listen for navigation
    this.page.on('framenavigated', async (frame) => {
      if (frame === this.page!.mainFrame()) {
        const newUrl = frame.url();
        if (newUrl !== this.currentUrl) {
          // Use the last action to describe how we got here
          let navigationDescription = `Navigated to ${newUrl}`;
          if (this.lastAction) {
            if (this.lastAction.type === 'click') {
              navigationDescription = `Navigated to ${newUrl} by clicking ${this.lastAction.element_selector || 'element'} (${this.lastAction.element_text || 'no text'})`;
            } else if (this.lastAction.type === 'type' && this.lastAction.key === 'Enter') {
              navigationDescription = `Navigated to ${newUrl} by pressing Enter after typing "${this.lastAction.input_text}"`;
            }
          }
          
          // Discover links on the new page
          const discoveredLinks = await this.discoverLinks();
          
          await this.recordAction({
            type: 'navigation',
            from_url: this.currentUrl,
            to_url: newUrl,
            actions: [{
              action_description: navigationDescription
            }],
            element_selector: this.lastAction?.element_selector,
            element_text: this.lastAction?.element_text,
            element_id: this.lastAction?.element_id,
            element_type: this.lastAction?.element_type,
            element_href: this.lastAction?.element_href,
            discovered_links: discoveredLinks
          });
          this.currentUrl = newUrl;
          
          // Wait for the new page to load
          await this.page!.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
            console.log('Navigation load timeout, continuing...');
          });
          
          // Take screenshot and capture HTML after navigation is complete
          await this.takeScreenshot('navigation', true);
          
          // Clear last action after navigation
          this.lastAction = null;
          
          // Re-setup monitoring after navigation
          await this.reinjectMonitoringScripts();
          
          // Update domain if it changed
          const newDomain = new URL(newUrl).hostname;
          if (newDomain !== this.currentSiteDomain) {
            this.currentSiteDomain = newDomain;
            console.log(`[Navigation] Domain changed to: ${this.currentSiteDomain}`);
            await this.loadAndApplySiteRules();
          }
        }
      }
    });

    // Handle dialog events for delete confirmation
    this.page.on('dialog', async (dialog) => {
      console.log('[PLAYWRIGHT DELETE] Dialog detected:', dialog.type(), dialog.message());
      if (dialog.message().includes('Delete component:')) {
        await dialog.accept(); // Auto-accept for now, we'll handle confirmation differently
      } else {
        await dialog.accept();
      }
    });

    // Expose a simple test function first
    await this.page.exposeFunction('testPlaywrightFunction', async () => {
      console.log('[PLAYWRIGHT TEST] Test function called successfully!');
      return 'test-success';
    });

    // Expose delete component function to browser context
    await this.page.exposeFunction('playwrightDeleteComponent', async (componentId: string, componentName: string) => {
      console.log('[PLAYWRIGHT DELETE] Delete request received:', componentId, componentName);
      console.log('[PLAYWRIGHT DELETE] Current site domain:', this.currentSiteDomain);
      console.log('[PLAYWRIGHT DELETE] Function called successfully!');
      console.log('[PLAYWRIGHT DELETE] Full componentId received:', JSON.stringify(componentId));
      console.log('[PLAYWRIGHT DELETE] Full componentName received:', JSON.stringify(componentName));
      
      try {
        // Make the API call from Node.js context to avoid CSP restrictions
        console.log('[PLAYWRIGHT DELETE] Making API call from Node.js context');
        
        const response = await fetch('http://localhost:3000/api/delete-trained-component', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ componentId, domain: this.currentSiteDomain })
        });
        
        console.log('[PLAYWRIGHT DELETE] Response status:', response.status);
        
        let result;
        if (!response.ok) {
          const errorText = await response.text();
          console.error('[PLAYWRIGHT DELETE] Response error:', response.status, errorText);
          result = { success: false, error: `HTTP ${response.status}: ${errorText}` };
        } else {
          result = await response.json();
          console.log('[PLAYWRIGHT DELETE] Response data:', result);
        }
        
        console.log('[PLAYWRIGHT DELETE] Delete result:', result);
        
        if (result?.success) {
          console.log('[PLAYWRIGHT DELETE] Deletion successful, reloading site rules and refreshing panel');
          
          // Show success message
          await this.page?.evaluate(() => {
            alert('Component deleted successfully!');
          });
          
          // Reload site rules to get fresh data from JSON file
          await this.loadAndApplySiteRules();
          
          // Close any existing panel and reopen it to refresh
          await this.page?.evaluate(() => {
            console.log('[PLAYWRIGHT DELETE] Refreshing trained data panel with reloaded rules');
            
            // Remove existing panel
            const existingPanel = document.getElementById('trained-data-panel');
            if (existingPanel) {
              console.log('[PLAYWRIGHT DELETE] Removing existing panel');
              existingPanel.remove();
            }
            
            // Small delay then reopen
            setTimeout(() => {
              console.log('[PLAYWRIGHT DELETE] Reopening panel with fresh data');
              if ((window as any).showTrainedData) {
                (window as any).showTrainedData();
              } else {
                console.error('[PLAYWRIGHT DELETE] showTrainedData function not found');
              }
            }, 100);
          });
          return true;
        } else {
          await this.page?.evaluate((errorMsg) => {
            alert('Failed to delete component: ' + errorMsg);
          }, result?.error || 'Unknown error');
          return false;
        }
      } catch (error) {
        console.error('[PLAYWRIGHT DELETE] Error:', error);
        await this.page?.evaluate((errorMsg) => {
          alert('Error deleting component: ' + errorMsg);
        }, (error as Error).message);
        return false;
      }
    });

    // Inject client-side event tracking
    await this.page.addInitScript(() => {
      // Track clicks
      document.addEventListener('click', (event) => {
        const target = event.target as HTMLElement;
        const rect = target.getBoundingClientRect();
        (window as any).lastInteractionData = {
          type: 'click',
          x: event.clientX,
          y: event.clientY,
          selector: getElementSelector(target),
          text: target.textContent?.trim() || target.innerText?.trim() || '',
          tagName: target.tagName,
          id: target.id,
          className: target.className,
          href: (target as HTMLAnchorElement).href || (target.closest('a') as HTMLAnchorElement)?.href || '',
          elementRect: {
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height
          },
          timestamp: Date.now()
        };
      });

      // Track typing
      document.addEventListener('input', (event) => {
        const target = event.target as HTMLInputElement;
        (window as any).lastInteractionData = {
          type: 'type',
          selector: getElementSelector(target),
          text: target.value,
          tagName: target.tagName,
          id: target.id,
          name: target.name,
          placeholder: target.placeholder,
          inputType: target.type,
          timestamp: Date.now()
        };
      });
      
      // Track key presses (especially Enter key)
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          const target = event.target as HTMLElement;
          (window as any).lastInteractionData = {
            type: 'type',
            key: 'Enter',
            selector: getElementSelector(target),
            text: (target as HTMLInputElement).value || '',
            tagName: target.tagName,
            id: target.id,
            timestamp: Date.now()
          };
        }
      });

      // Track scrolling
      document.addEventListener('scroll', (event) => {
        (window as any).lastInteractionData = {
          type: 'scroll',
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          timestamp: Date.now()
        };
      });

      // Helper function to get CSS selector
      function getElementSelector(element: HTMLElement): string {
        // Build a more descriptive selector
        let selector = element.tagName.toLowerCase();
        
        if (element.id) {
          selector += `#${element.id}`;
        } else if (element.className) {
          const classes = element.className.split(' ').filter(c => c.length > 0);
          if (classes.length > 0) {
            selector += `.${classes.join('.')}`;
          }
        }
        
        // Add text content for better identification
        const text = element.textContent?.trim();
        if (text && text.length < 30) {
          selector += `[text="${text}"]`;
        }
        
        return selector;
      }
    });

    // Poll for interactions
    const pollInterval = setInterval(async () => {
      if (!this.isRecording || !this.page) {
        clearInterval(pollInterval);
        return;
      }
      
      try {
        const interactionData = await this.page.evaluate(() => {
          const data = (window as any).lastInteractionData;
          (window as any).lastInteractionData = null;
          return data;
        });

        if (interactionData) {
          // Determine the correct to_url based on the interaction
          let toUrl = this.currentUrl;
          if (interactionData.href && interactionData.type === 'click') {
            toUrl = interactionData.href;
          }
          
          const action: RecordedAction = {
            id: uuidv4(),
            timestamp: new Date().toISOString(),
            type: interactionData.type,
            from_url: this.currentUrl,
            to_url: toUrl,
            actions: [{
              action_description: this.formatActionDescription(interactionData)
            }],
            position: interactionData.x ? { x: interactionData.x, y: interactionData.y } : undefined,
            element_selector: interactionData.selector,
            element_text: interactionData.text,
            element_id: interactionData.id,
            element_type: interactionData.tagName,
            element_name: interactionData.name,
            element_placeholder: interactionData.placeholder,
            element_href: interactionData.href,
            input_text: interactionData.text,
            key: interactionData.key,
            scroll_delta: interactionData.scrollX ? { x: interactionData.scrollX, y: interactionData.scrollY } : undefined
          };
          
          // Store this as the last action (for navigation description)
          this.lastAction = action;
          
          await this.recordAction(action);
        }
      } catch (error) {
        // Ignore errors from closed pages
      }
    }, 200);
  }

  private formatActionDescription(data: any): string {
    switch (data.type) {
      case 'click':
        let clickDesc = `Clicked on ${data.tagName}`;
        if (data.id) clickDesc += ` with id="${data.id}"`;
        if (data.text) clickDesc += ` containing text "${data.text}"`;
        if (data.href) clickDesc += ` (link to: ${data.href})`;
        clickDesc += ` at position (${data.x}, ${data.y})`;
        return clickDesc;
      case 'type':
        if (data.key === 'Enter') {
          return `Pressed Enter key in ${data.tagName}${data.id ? ` #${data.id}` : ''} after typing "${data.text}"`;
        }
        let typeDesc = `Typed "${data.text}" in ${data.tagName}`;
        if (data.id) typeDesc += ` with id="${data.id}"`;
        if (data.name) typeDesc += ` name="${data.name}"`;
        if (data.placeholder) typeDesc += ` (placeholder: "${data.placeholder}")`;
        return typeDesc;
      case 'scroll':
        return `Scrolled to position (${data.scrollX}, ${data.scrollY})`;
      default:
        return `${data.type} action performed`;
    }
  }

  private async recordAction(actionData: (Partial<RecordedAction> & { action_description?: string }) | RecordedAction) {
    if (!this.isRecording || !this.recordingSession) return;
    
    // Skip recording actions when in training mode, except for training-related actions
    if (this.isTrainingMode) {
      const description = 'action_description' in actionData 
        ? actionData.action_description 
        : (actionData.actions && actionData.actions[0]?.action_description) || actionData.type || 'Unknown action';
      
      // Allow specific training-related actions to be recorded
      const isTrainingAction = actionData.type === 'manual_capture' || 
                              actionData.type === 'modal_training' ||
                              (description && description.includes('Train Modal Detection')) ||
                              (description && description.includes('Discover Modals')) ||
                              (description && description.includes('manual modal detection'));
      
      if (!isTrainingAction) {
        console.log(`[Training Mode] Skipping action recording: ${description}`);
        return;
      } else {
        console.log(`[Training Mode] Allowing training action: ${description}`);
      }
    }

    let action: RecordedAction;

    // If it's already a full RecordedAction, just add it
    if ('id' in actionData && 'timestamp' in actionData) {
      action = actionData as RecordedAction;
      this.recordingSession.actions.push(action);
      console.log(`Recorded action: ${action.actions[0]?.action_description || 'Unknown action'}`);
    } else {
      // Check if actions array is provided, otherwise create from action_description
      let actionsArray = actionData.actions || [];
      if (actionsArray.length === 0 && actionData.action_description) {
        actionsArray = [{
          action_description: actionData.action_description
        }];
      }
      
      // Add screenshot links to actions if we just took a screenshot
      if (actionData.type === 'navigation' || actionData.type === 'manual_capture') {
        // Get the most recent screenshot
        const latestScreenshot = this.recordingSession.screenshots[this.recordingSession.screenshots.length - 1];
        if (latestScreenshot && actionsArray.length > 0) {
          actionsArray[0].screenshot = latestScreenshot;
        }
      }

      // Create a new action
      action = {
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        type: actionData.type || 'navigation',
        from_url: actionData.from_url || this.currentUrl,
        to_url: actionData.to_url || this.currentUrl,
        actions: actionsArray,
        position: actionData.position,
        element_selector: actionData.element_selector,
        element_text: actionData.element_text,
        input_text: actionData.input_text,
        key: actionData.key,
        scroll_delta: actionData.scroll_delta,
        discovered_links: actionData.discovered_links
      };

      this.recordingSession.actions.push(action);
      console.log(`Recorded action: ${action.actions[0]?.action_description || 'Unknown action'}`);
    }

    // Keep history for modal correlation
    this.actionHistory.push(action);
    // Keep only last 10 actions for memory efficiency
    if (this.actionHistory.length > 10) {
      this.actionHistory = this.actionHistory.slice(-10);
    }

    // Update browser state for modal detection correlation
    await this.updateBrowserActionContext(action);
  }

  private async updateBrowserActionContext(action: RecordedAction) {
    if (!this.page) return;

    try {
      // Send action context to browser for correlation with DOM changes
      await this.page.evaluate((actionData) => {
        (window as any).lastUserAction = {
          type: actionData.type,
          description: actionData.actions?.[0]?.action_description || 'Unknown action',
          timestamp: actionData.timestamp,
          element: actionData.element_selector,
          text: actionData.element_text
        };
      }, action);
    } catch (error) {
      // Ignore errors from closed pages
    }
  }

  private async takeScreenshot(suffix: string, captureHtml: boolean = false) {
    if (!this.page || !this.recordingSession) return;

    // Skip taking automatic screenshots when in training mode, but allow manual training screenshots
    if (this.isTrainingMode) {
      const isTrainingScreenshot = suffix.includes('manual') || 
                                  suffix.includes('modal') || 
                                  suffix.includes('training') ||
                                  suffix.includes('component');
      
      if (!isTrainingScreenshot) {
        console.log(`[Training Mode] Skipping automatic screenshot: ${suffix}`);
        return;
      } else {
        console.log(`[Training Mode] Allowing training screenshot: ${suffix}`);
      }
    }

    try {
      const sessionDir = path.join(process.cwd(), 'recordings', `session_${this.recordingSession.id}`);
      const screenshotsDir = path.join(sessionDir, 'screenshots');
      await fs.mkdir(screenshotsDir, { recursive: true });

      // Generate slug from current URL
      const slug = this.generateSlugFromUrl(this.currentUrl);
      
      // Count existing page screenshots for this slug
      const existingPageShots = this.recordingSession.screenshots.filter(s => 
        s.startsWith(`${slug}_page_`)
      ).length;
      const pageIndex = (existingPageShots + 1).toString().padStart(3, '0');
      
      const filename = `${slug}_page_${pageIndex}.png`;
      const filepath = path.join(screenshotsDir, filename);

      // Hide debug overlay before screenshot
      await this.page.evaluate(() => {
        const overlay = document.getElementById('crawler-debug-overlay');
        if (overlay) overlay.style.display = 'none';
      });

      await this.page.screenshot({
        path: filepath,
        fullPage: true // Capture entire page
      });

      // Show overlay after screenshot
      await this.page.evaluate(() => {
        const overlay = document.getElementById('crawler-debug-overlay');
        if (overlay) overlay.style.display = 'block';
      });

      this.recordingSession.screenshots.push(filename);
      console.log(`Screenshot saved: ${filename}`);
      
      // Only capture HTML when explicitly requested
      if (captureHtml) {
        console.log(`Capturing HTML after screenshot ${filename}`);
        await this.capturePageHtml();
      }
    } catch (error) {
      console.error('Error taking screenshot:', error);
    }
  }

  private async saveRecordingSession() {
    if (!this.recordingSession) return;

    // Skip saving recording session when in training mode
    if (this.isTrainingMode) {
      console.log(`[Training Mode] Skipping recording session save`);
      return;
    }

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

  // Public getters
  getCurrentUrl(): string {
    return this.currentUrl;
  }

  isSessionActive(): boolean {
    return this.isRecording;
  }

  getRecordingSession(): RecordingSession | null {
    return this.recordingSession;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getPage(): Page | null {
    return this.page;
  }

  // Manual modal detection trigger for testing
  async triggerModalDetection() {
    console.log('[Modal Detection] Manual trigger activated');
    await this.detectAndCaptureModal();
  }

  // Manual capture of a specific area
  async manualCapture(boundingBox?: { x: number; y: number; width: number; height: number }) {
    if (!this.page || !this.recordingSession || !this.isRecording) {
      throw new Error('No active recording session');
    }

    // Skip manual capture when in training mode
    if (this.isTrainingMode) {
      console.log(`[Training Mode] Skipping manual capture`);
      return {
        success: false,
        filename: 'training_mode_skip.png',
        filepath: 'training_mode_skip'
      };
    }

    try {
      const sessionDir = path.join(process.cwd(), 'recordings', `session_${this.recordingSession.id}`);
      const screenshotsDir = path.join(sessionDir, 'screenshots');
      await fs.mkdir(screenshotsDir, { recursive: true });

      // Generate slug from current URL
      const slug = this.generateSlugFromUrl(this.currentUrl);
      
      // Count existing captures for this slug
      const existingCaptures = this.recordingSession.screenshots.filter(s => 
        s.startsWith(`${slug}_capture_`)
      ).length;
      const captureIndex = (existingCaptures + 1).toString().padStart(3, '0');
      
      const filename = `${slug}_capture_${captureIndex}.png`;
      const filepath = path.join(screenshotsDir, filename);

      // Take screenshot
      if (boundingBox) {
        // Capture specific area
        await this.page.screenshot({
          path: filepath,
          clip: boundingBox
        });
        console.log(`[Manual Capture] Area captured: ${filename} (${boundingBox.width}x${boundingBox.height} at ${boundingBox.x},${boundingBox.y})`);
      } else {
        // Capture full viewport
        await this.page.screenshot({
          path: filepath,
          fullPage: false
        });
        console.log(`[Manual Capture] Viewport captured: ${filename}`);
      }

      // Add to screenshots list
      this.recordingSession.screenshots.push(filename);

      // Record this as an action with new format
      await this.recordAction({
        type: 'manual_capture',
        from_url: this.currentUrl,
        to_url: this.currentUrl,
        actions: [{
          action_description: boundingBox 
            ? `Manual area capture: ${boundingBox.width}x${boundingBox.height} at ${boundingBox.x},${boundingBox.y}` 
            : 'Manual full viewport capture',
          screenshot: filename
        }],
        capture_details: {
          timestamp: new Date().toISOString(),
          filename: filename,
          capture_type: boundingBox ? 'area' : 'viewport',
          dimensions: boundingBox ? {
            x: boundingBox.x,
            y: boundingBox.y,
            width: boundingBox.width,
            height: boundingBox.height
          } : {
            width: await this.page.evaluate(() => window.innerWidth),
            height: await this.page.evaluate(() => window.innerHeight)
          },
          page_url: this.currentUrl,
          page_title: await this.page.title().catch(() => 'Unknown')
        }
      });

      return {
        success: true,
        filename,
        filepath
      };
    } catch (error) {
      console.error('[Manual Capture] Error:', error);
      throw error;
    }
  }

  // Debug method to list all fixed position elements
  async debugFixedElements() {
    if (!this.page) return;
    
    const fixedElements = await this.page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('*')).filter(el => {
        const style = window.getComputedStyle(el);
        return style.position === 'fixed';
      });
      
      return elements.map(el => ({
        tag: el.tagName,
        id: el.id,
        classes: el.className,
        zIndex: window.getComputedStyle(el).zIndex,
        dimensions: {
          width: el.getBoundingClientRect().width,
          height: el.getBoundingClientRect().height
        },
        visible: window.getComputedStyle(el).display !== 'none' && 
                 window.getComputedStyle(el).visibility !== 'hidden' &&
                 window.getComputedStyle(el).opacity !== '0',
        textPreview: el.textContent?.trim().substring(0, 50) || ''
      }));
    });
    
    console.log('[Debug] Fixed position elements on page:', fixedElements);
    return fixedElements;
  }

  // Debug method to analyze current page for modals
  async debugCurrentModals() {
    if (!this.page) return;
    
    console.log('[Debug] Starting comprehensive modal analysis...');
    
    const analysis = await this.page.evaluate(() => {
      // Re-run our modal detection logic manually
      const allElements = Array.from(document.querySelectorAll('*'));
      console.log(`[Debug Browser] Analyzing ${allElements.length} elements`);
      
      const candidates = [];
      
      // Look for elements with modal-like characteristics
      for (const element of allElements) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        
        // Basic visibility check
        if (rect.width < 50 || rect.height < 50 ||
            style.display === 'none' || 
            style.visibility === 'hidden' ||
            style.opacity === '0') {
          continue;
        }
        
        let score = 0;
        const reasons = [];
        
        // Position scoring
        if (style.position === 'fixed') {
          score += 30;
          reasons.push('fixed position');
        }
        if (style.position === 'absolute') {
          score += 20;
          reasons.push('absolute position');
        }
        
        // Z-index scoring
        const zIndex = parseInt(style.zIndex) || 0;
        if (zIndex > 1000) {
          score += 25;
          reasons.push(`high z-index: ${zIndex}`);
        } else if (zIndex > 100) {
          score += 15;
          reasons.push(`elevated z-index: ${zIndex}`);
        }
        
        // Size and centering
        if (rect.width > 300 && rect.width < window.innerWidth * 0.8 &&
            rect.height > 200 && rect.height < window.innerHeight * 0.8) {
          score += 25;
          reasons.push('modal-like dimensions');
        }
        
        // Content analysis
        const text = element.textContent?.toLowerCase() || '';
        const className = element.className?.toLowerCase() || '';
        
        if (text.includes('login') || text.includes('log in') || text.includes('password') || text.includes('email')) {
          score += 20;
          reasons.push('contains auth keywords');
        }
        
        if (className.includes('modal') || className.includes('dialog') || className.includes('popup')) {
          score += 15;
          reasons.push('modal-like class names');
        }
        
        if (element.querySelector('input, button, form')) {
          score += 10;
          reasons.push('contains form elements');
        }
        
        if (score > 30) {
          candidates.push({
            tag: element.tagName,
            id: element.id,
            classes: element.className,
            score: score,
            reasons: reasons,
            dimensions: {
              width: rect.width,
              height: rect.height,
              top: rect.top,
              left: rect.left
            },
            zIndex: zIndex,
            textPreview: text.substring(0, 100)
          });
        }
      }
      
      candidates.sort((a, b) => b.score - a.score);
      return candidates;
    });
    
    console.log('[Debug] Modal candidates found:', analysis);
    
    // Also check mutation observer state
    const mutationState = await this.page.evaluate(() => {
      return {
        observerExists: !!window.MutationObserver,
        detectionStateExists: !!(window as any).modalDetectionState,
        checkFunctionExists: !!(window as any).checkForNewModals,
        lastActionExists: !!(window as any).lastUserAction,
        triggeredFlag: (window as any).modalDetectionTriggered
      };
    });
    
    console.log('[Debug] Mutation observer state:', mutationState);
    
    return { candidates: analysis, mutationState };
  }

  // Store modal training data for site-specific parsing rules
  private async storeModalTrainingData(consoleMessage: string) {
    try {
      // Extract training data from console message
      const trainingDataMatch = consoleMessage.match(/\[Modal Training\] Element selected for training: (.+)/);
      if (!trainingDataMatch) return;

      let trainingData;
      try {
        trainingData = JSON.parse(trainingDataMatch[1]);
      } catch (jsonError) {
        console.error('[Modal Training] JSON parsing error:', jsonError);
        console.error('[Modal Training] Raw data:', trainingDataMatch[1]);
        return; // Skip this training data if it's malformed
      }
      
      // ALWAYS use the new consolidated system for training data
      await this.updateSiteSpecificParsingRules(trainingData);
      console.log(`[Modal Training] Updated consolidated parsing rules for domain: ${this.currentSiteDomain}`);
      
    } catch (error) {
      console.error('[Modal Training] Error storing training data:', error);
    }
  }

  // Update site-specific parsing rules with new consolidated structure
  private async updateSiteSpecificParsingRules(trainingData: any) {
    if (!this.currentSiteDomain) {
      console.error('[Modal Training] No current site domain available');
      return;
    }

    console.log(`[Modal Training] Updating rules for domain: ${this.currentSiteDomain}`);
    console.log(`[Modal Training] Training data received:`, trainingData);

    const rulesDir = path.join(process.cwd(), 'modal-parsing-rules');
    await fs.mkdir(rulesDir, { recursive: true });
    
    const rulesFile = path.join(rulesDir, `${this.currentSiteDomain}.json`);
    console.log(`[Modal Training] Rules file path: ${rulesFile}`);
    
    // New structure: single file with all trained components
    interface TrainedComponent {
      id: string;
      pageUrl: string;
      pagePath: string;
      type: string; // 'modal', 'popup', 'dialog', 'notification', 'custom'
      name: string; // User-assigned name
      selector: string;
      trainingData: any;
      createdAt: string;
      lastUpdated: string;
    }
    
    interface SiteRules {
      domain: string;
      lastUpdated: string;
      version: number;
      trainedComponents: TrainedComponent[];
    }
    
    let siteRules: SiteRules = {
      domain: this.currentSiteDomain,
      lastUpdated: new Date().toISOString(),
      version: 1,
      trainedComponents: []
    };

    try {
      const existingRules = await fs.readFile(rulesFile, 'utf-8');
      siteRules = JSON.parse(existingRules);
    } catch (error) {
      // File doesn't exist, use default rules
    }
    
    // Check if we're updating an existing component or adding a new one
    const currentPageUrl = this.currentUrl;
    const currentPagePath = new URL(currentPageUrl).pathname;
    const componentId = this.generateComponentId(trainingData);
    
    const existingIndex = siteRules.trainedComponents.findIndex(
      comp => comp.id === componentId && comp.pageUrl === currentPageUrl
    );
    
    // Get type and name from training data or use defaults
    const componentType = trainingData.componentType || 'modal';
    const componentName = trainingData.componentName || `${componentType}_${Date.now()}`;

    const trainedComponent: TrainedComponent = {
      id: componentId,
      pageUrl: currentPageUrl,
      pagePath: currentPagePath,
      type: componentType,
      name: componentName,
      selector: this.generateModalSelector(trainingData),
      trainingData: {
        ...trainingData,
        contextElements: await this.getContextElements(trainingData)
      },
      createdAt: existingIndex >= 0 ? siteRules.trainedComponents[existingIndex].createdAt : new Date().toISOString(),
      lastUpdated: new Date().toISOString()
    };
    
    if (existingIndex >= 0) {
      // Update existing component
      siteRules.trainedComponents[existingIndex] = trainedComponent;
      console.log(`[Modal Training] Updated existing component: ${componentName} on ${currentPagePath}`);
    } else {
      // Add new component
      siteRules.trainedComponents.push(trainedComponent);
      console.log(`[Modal Training] Added new component: ${componentName} on ${currentPagePath}`);
    }
    
    siteRules.lastUpdated = new Date().toISOString();
    siteRules.version++;
    
    try {
      await fs.writeFile(rulesFile, JSON.stringify(siteRules, null, 2));
      console.log(`[Modal Training] Successfully wrote rules file: ${rulesFile}`);
      console.log(`[Modal Training] File contains ${siteRules.trainedComponents.length} components`);
    } catch (writeError) {
      console.error(`[Modal Training] Error writing rules file:`, writeError);
      throw writeError;
    }
    
    // Update browser detection rules immediately
    await this.loadAndApplySiteRules();
    
    console.log(`[Modal Rules] Updated parsing rules for ${this.currentSiteDomain}: ${siteRules.trainedComponents.length} total components`);
  }
  
  // Generate unique component ID based on element characteristics
  private generateComponentId(trainingData: any): string {
    const parts = [];
    if (trainingData.primaryClass) parts.push(trainingData.primaryClass);
    if (trainingData.tagName) parts.push(trainingData.tagName);
    if (trainingData.position) parts.push(trainingData.position);
    if (trainingData.zIndex) parts.push(`z${trainingData.zIndex}`);
    return parts.join('_').replace(/[^a-zA-Z0-9_-]/g, '') || `component_${Date.now()}`;
  }

  // Generate a specific CSS selector for the modal
  private generateModalSelector(trainingData: any): string {
    // For the primary class, use it directly
    if (trainingData.primaryClass) {
      // If it's a styled-component class like "styled__ModalWrapper-sc-7eym6d-0"
      if (trainingData.primaryClass.includes('styled__')) {
        return `.${trainingData.primaryClass}`;
      }
      
      // For other classes, combine with tag if available
      const tag = trainingData.tagName ? trainingData.tagName.toLowerCase() : '';
      return tag ? `${tag}.${trainingData.primaryClass}` : `.${trainingData.primaryClass}`;
    }
    
    // Fallback to tag name
    if (trainingData.tagName) {
      return trainingData.tagName.toLowerCase();
    }
    
    // Last resort - attribute selector
    if (trainingData.id) {
      return `#${trainingData.id}`;
    }
    
    return 'div'; // Generic fallback
  }

  // Load and apply site-specific rules to browser
  private async loadAndApplySiteRules() {
    if (!this.page || !this.currentSiteDomain) return;

    const rulesFile = path.join(process.cwd(), 'modal-parsing-rules', `${this.currentSiteDomain}.json`);
    
    try {
      const rulesContent = await fs.readFile(rulesFile, 'utf-8');
      const siteRules = JSON.parse(rulesContent);
      
      // Inject site-specific rules into the page
      await this.page.evaluate((rules) => {
        // Store site-specific rules globally
        (window as any).siteSpecificModalRules = rules;
        
        // Enhanced modal detection using site rules
        (window as any).detectModalsBySiteRules = () => {
          const candidates: any[] = [];
          const rules = (window as any).siteSpecificModalRules;
          const currentPath = window.location.pathname;
          
          if (!rules || !rules.trainedComponents) return candidates;
          
          // Filter components for current page
          const pageComponents = rules.trainedComponents.filter((comp: any) => 
            comp.pagePath === currentPath || comp.pageUrl === window.location.href
          );
          
          console.log(`[Modal Rules] Found ${pageComponents.length} trained components for current page`);
          
          // Apply each component's selector
          pageComponents.forEach((component: any) => {
            try {
              const elements = document.querySelectorAll(component.selector);
              elements.forEach((element: Element) => {
                const style = window.getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                
                let score = 95; // High confidence for trained components
                const reasons = [`trained ${component.type}: ${component.name}`];
                
                // Verify element is visible
                if (rect.width > 0 && rect.height > 0) {
                  candidates.push({
                    element,
                    score,
                    reasons,
                    componentId: component.id,
                    componentName: component.name,
                    componentType: component.type,
                    selector: component.selector,
                    dimensions: {
                      width: rect.width,
                      height: rect.height,
                      top: rect.top,
                      left: rect.left
                    }
                  });
                }
              });
            } catch (error) {
              console.warn('Error applying component selector:', component.id, error);
            }
          });
          
          return candidates.sort((a, b) => b.score - a.score);
        };
        
        console.log('[Modal Rules] Site-specific rules loaded:', rules.trainedComponents.length, 'components for', rules.domain);
        // Rules loaded successfully
        
        // Set up component monitoring after rules are loaded
        if ((window as any).refreshComponentMonitoring) {
          console.log('[Rules] Calling refreshComponentMonitoring after rules loaded');
          (window as any).refreshComponentMonitoring();
        } else {
          console.log('[Rules] refreshComponentMonitoring function not available yet - will retry');
          // Retry after a short delay
          setTimeout(() => {
            if ((window as any).refreshComponentMonitoring) {
              console.log('[Rules] Retrying refreshComponentMonitoring after delay');
              (window as any).refreshComponentMonitoring();
            } else {
              console.log('[Rules] refreshComponentMonitoring still not available after delay');
            }
          }, 1000);
        }
      }, siteRules);
      
    } catch (error) {
      console.log(`[Modal Rules] No site-specific rules found for ${this.currentSiteDomain}, using default detection`);
    }
  }

  // Legacy training data storage - REMOVED to prevent multiple JSON files
  // All training data now goes through the consolidated system only

  // Get context elements around the selected element
  private async getContextElements(trainingData: any) {
    if (!this.page) return [];

    return await this.page.evaluate((data) => {
      // Validate coordinates before using elementFromPoint
      const x = (data.left || 0) + (data.width || 0) / 2;
      const y = (data.top || 0) + (data.height || 0) / 2;
      
      if (!isFinite(x) || !isFinite(y)) {
        console.log('[Context Elements] Invalid coordinates:', { x, y, data });
        return [];
      }
      
      const targetElement = document.elementFromPoint(x, y);
      if (!targetElement) return [];

      const context = [];
      
      // Get parent elements up to 3 levels
      let current = targetElement.parentElement;
      let level = 0;
      while (current && level < 3) {
        const style = window.getComputedStyle(current);
        context.push({
          tagName: current.tagName.toLowerCase(),
          className: current.className,
          position: style.position,
          zIndex: parseInt(style.zIndex) || 0,
          level: level + 1,
          relationship: 'parent'
        });
        current = current.parentElement;
        level++;
      }

      // Get sibling elements
      const siblings = Array.from(targetElement.parentElement?.children || []);
      siblings.forEach(sibling => {
        if (sibling !== targetElement) {
          const style = window.getComputedStyle(sibling);
          context.push({
            tagName: sibling.tagName.toLowerCase(),
            className: sibling.className,
            position: style.position,
            zIndex: parseInt(style.zIndex) || 0,
            level: 0,
            relationship: 'sibling'
          });
        }
      });

      return context;
    }, trainingData);
  }

  // Update training summary with patterns
  private async updateTrainingSummary(trainingData: any) {
    if (!this.recordingSession) return;

    const sessionDir = path.join(process.cwd(), 'recordings', `session_${this.recordingSession.id}`);
    const trainingDir = path.join(sessionDir, 'modal-training');
    const summaryFile = path.join(trainingDir, 'training-summary.json');

    let summary = {
      totalSamples: 0,
      commonPatterns: {
        classNames: new Map(),
        positions: new Map(),
        tagNames: new Map(),
        zIndexRanges: new Map()
      },
      lastUpdated: new Date().toISOString()
    };

    // Load existing summary if it exists
    try {
      const existingSummary = await fs.readFile(summaryFile, 'utf-8');
      const parsedSummary = JSON.parse(existingSummary);
      
      // Convert plain objects back to Maps (JSON doesn't preserve Map objects)
      summary = {
        ...parsedSummary,
        commonPatterns: {
          classNames: new Map(Object.entries(parsedSummary.commonPatterns?.classNames || {})),
          positions: new Map(Object.entries(parsedSummary.commonPatterns?.positions || {})),
          tagNames: new Map(Object.entries(parsedSummary.commonPatterns?.tagNames || {})),
          zIndexRanges: new Map(Object.entries(parsedSummary.commonPatterns?.zIndexRanges || {}))
        }
      };
    } catch (error) {
      // File doesn't exist, use default summary
    }

    // Update patterns
    summary.totalSamples++;
    
    // Track class name patterns
    const classKey = trainingData.primaryClass;
    summary.commonPatterns.classNames.set(classKey, (summary.commonPatterns.classNames.get(classKey) || 0) + 1);
    
    // Track position patterns
    summary.commonPatterns.positions.set(trainingData.position, (summary.commonPatterns.positions.get(trainingData.position) || 0) + 1);
    
    // Track tag patterns
    summary.commonPatterns.tagNames.set(trainingData.tagName, (summary.commonPatterns.tagNames.get(trainingData.tagName) || 0) + 1);
    
    // Track z-index ranges
    const zIndexRange = trainingData.zIndex > 1000 ? 'high' : trainingData.zIndex > 100 ? 'medium' : 'low';
    summary.commonPatterns.zIndexRanges.set(zIndexRange, (summary.commonPatterns.zIndexRanges.get(zIndexRange) || 0) + 1);

    summary.lastUpdated = new Date().toISOString();

    // Convert Maps to Objects for JSON serialization
    const serializedSummary = {
      ...summary,
      commonPatterns: {
        classNames: Object.fromEntries(summary.commonPatterns.classNames),
        positions: Object.fromEntries(summary.commonPatterns.positions),
        tagNames: Object.fromEntries(summary.commonPatterns.tagNames),
        zIndexRanges: Object.fromEntries(summary.commonPatterns.zIndexRanges)
      }
    };

    await fs.writeFile(summaryFile, JSON.stringify(serializedSummary, null, 2));
  }

  // Update modal detection rules based on training data
  private async updateModalDetectionRules(trainingData: any) {
    if (!this.page) return;

    // Inject improved detection logic based on training data
    await this.page.evaluate((data) => {
      // Update the global modal detection scoring
      if (!(window as any).modalTrainingData) {
        (window as any).modalTrainingData = [];
      }
      
      (window as any).modalTrainingData.push(data);
      
      // Create or update enhanced scoring function
      (window as any).enhancedModalScoring = (element: Element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const className = element.className.toLowerCase();
        let score = 0;
        const reasons = [];

        // Base scoring (existing logic)
        if (style.position === 'fixed') {
          score += 30;
          reasons.push('fixed position');
        } else if (style.position === 'absolute') {
          score += 25;
          reasons.push('absolute position');
        }

        const zIndex = parseInt(style.zIndex) || 0;
        if (zIndex > 1000) {
          score += 25;
          reasons.push('high z-index');
        } else if (zIndex > 100) {
          score += 15;
          reasons.push('medium z-index');
        }

        // Enhanced scoring based on training data
        const trainingData = (window as any).modalTrainingData || [];
        
        for (const training of trainingData) {
          // Check for class name patterns
          if (training.primaryClass && className.includes(training.primaryClass.toLowerCase())) {
            score += 40; // High bonus for exact class match
            reasons.push(`learned class pattern: ${training.primaryClass}`);
          }
          
          // Check for styled component patterns
          if (training.allClasses && /styled__.*modal/i.test(training.allClasses) && 
              /styled__.*modal/i.test(element.className)) {
            score += 35;
            reasons.push('styled component modal pattern');
          }
          
          // Check for similar positioning
          if (training.position === style.position) {
            score += 10;
            reasons.push(`matching position: ${style.position}`);
          }
          
          // Check for similar dimensions
          const sizeSimilarity = Math.abs(rect.width - training.width) < 100 && 
                                Math.abs(rect.height - training.height) < 100;
          if (sizeSimilarity) {
            score += 15;
            reasons.push('similar dimensions to trained modal');
          }
        }

        // Check for form elements (common in modals)
        if (element.querySelector('input, button, form, textarea, select')) {
          score += 15;
          reasons.push('contains form elements');
        }

        // Enhanced content analysis
        const text = element.textContent?.toLowerCase() || '';
        const modalKeywords = ['edit', 'create', 'add', 'delete', 'confirm', 'save', 'cancel', 'close', 'settings', 'options'];
        const foundKeywords = modalKeywords.filter(keyword => text.includes(keyword));
        if (foundKeywords.length > 0) {
          score += foundKeywords.length * 5;
          reasons.push(`modal keywords: ${foundKeywords.join(', ')}`);
        }

        return { score, reasons };
      };

      console.log('[Modal Training] Enhanced detection rules updated with training data');
    }, trainingData);
  }

  // Enable automatic modal interaction tracking
  private async enableModalInteractionTracking() {
    if (!this.page) return;
    
    // Injecting modal interaction tracking scripts...

    this.modalInteractionEnabled = true;
    
    // Inject modal interaction tracking script
    await this.page.addInitScript(() => {
      // Debug mode control
      (window as any).debugModalTracking = false; // Set to true to enable verbose logging
      
      function debugLog(...args: any[]) {
        if ((window as any).debugModalTracking) {
          console.log(...args);
        }
      }
      
      // Immediate debug message to confirm script injection
      debugLog('[SCRIPT INJECTION] Modal tracking script successfully injected!');
      const trackedModalIds = new Set<string>();
      
      // Function to generate unique modal ID
      function generateModalId(element: Element): string {
        const rect = element.getBoundingClientRect();
        const className = element.className || 'no-class';
        return `modal_${className.replace(/\s+/g, '_')}_${Math.round(rect.left)}_${Math.round(rect.top)}`;
      }

      // Function to detect if element is a modal using site rules or enhanced scoring
      function isModalElement(element: Element): boolean {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        
        // Exclude viewport-sized elements (likely overlays/backdrops)
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        
        if (rect.width > viewportWidth * 0.95 || rect.height > viewportHeight * 0.95) {
          return false; // Too large to be actual modal content
        }
        
        // Exclude very small elements
        if (rect.width < 200 || rect.height < 150) {
          return false; // Too small to be a modal
        }
        
        // Check for typical modal characteristics
        let score = 0;
        
        // Position-based scoring
        if (style.position === 'fixed') score += 20;
        if (style.position === 'absolute') score += 15;
        
        // Z-index scoring
        const zIndex = parseInt(style.zIndex) || 0;
        if (zIndex > 1000) score += 20;
        else if (zIndex > 100) score += 10;
        
        // Class name scoring
        const className = element.className.toLowerCase();
        if (/\b(modal|dialog|popup)\b/.test(className)) score += 25;
        if (/modal.*content|dialog.*content/.test(className)) score += 15;
        
        // Role and aria attributes
        if (element.getAttribute('role') === 'dialog') score += 20;
        if (element.getAttribute('aria-modal') === 'true') score += 20;
        
        // Size scoring (reasonable modal dimensions)
        if (rect.width > 300 && rect.width < viewportWidth * 0.8 &&
            rect.height > 200 && rect.height < viewportHeight * 0.8) {
          score += 15;
        }
        
        // Check for modal content indicators
        const hasFormElements = element.querySelector('input, button, form, textarea, select');
        if (hasFormElements) score += 10;
        
        const hasHeading = element.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]');
        if (hasHeading) score += 10;
        
        // First try site-specific rules (with size validation)
        if ((window as any).detectModalsBySiteRules) {
          const candidates = (window as any).detectModalsBySiteRules();
          const found = candidates.find((candidate: any) => candidate.element === element);
          if (found && found.score > 70) {
            return true;
          }
        }
        
        // Enhanced scoring with our additional checks
        if ((window as unknown as { enhancedModalScoring?: (el: Element) => { score: number } }).enhancedModalScoring) {
          const result = (window as unknown as { enhancedModalScoring: (el: Element) => { score: number } }).enhancedModalScoring(element);
          score += result.score;
        }
        
        return score > 50;
      }

      // Function to start tracking modal interactions
      function startTrackingModal(modalElement: Element) {
        const modalId = generateModalId(modalElement);
        
        if (trackedModalIds.has(modalId)) return; // Already tracking
        trackedModalIds.add(modalId);

        console.log('[Modal Tracker] Started tracking modal:', modalId);

        // Track clicks within modal
        modalElement.addEventListener('click', (e) => {
          const mouseEvent = e as MouseEvent;
          const target = mouseEvent.target as Element;
          const targetInfo = {
            tagName: target.tagName.toLowerCase(),
            className: target.className,
            textContent: target.textContent?.trim(),
            type: target.getAttribute('type'),
            position: {
              x: mouseEvent.clientX,
              y: mouseEvent.clientY
            }
          };

          console.log('[Modal Interaction] Click tracked:', JSON.stringify({
            modalId,
            target: targetInfo,
            timestamp: new Date().toISOString()
          }));
        }, true);

        // Track keyboard events within modal
        modalElement.addEventListener('keydown', (e) => {
          const keyboardEvent = e as KeyboardEvent;
          const target = keyboardEvent.target as Element;
          const keyInfo = {
            key: keyboardEvent.key,
            code: keyboardEvent.code,
            ctrlKey: keyboardEvent.ctrlKey,
            shiftKey: keyboardEvent.shiftKey,
            altKey: keyboardEvent.altKey,
            target: {
              tagName: target.tagName.toLowerCase(),
              className: target.className,
              value: (target as HTMLInputElement).value
            }
          };

          console.log('[Modal Interaction] Keydown tracked:', {
            modalId,
            key: keyInfo,
            timestamp: new Date().toISOString()
          });
        }, true);

        // Track input changes within modal
        modalElement.addEventListener('input', (e) => {
          const target = e.target as HTMLInputElement;
          const inputInfo = {
            tagName: target.tagName.toLowerCase(),
            type: target.type,
            name: target.name,
            value: target.value,
            placeholder: target.placeholder
          };

          console.log('[Modal Interaction] Input change tracked:', {
            modalId,
            input: inputInfo,
            timestamp: new Date().toISOString()
          });
        }, true);

        // Set up content change detection for this modal
        startModalContentChangeDetection(modalElement, modalId);
      }

      // Function to detect modal content changes
      function startModalContentChangeDetection(modalElement: Element, modalId: string) {
        let lastContent = modalElement.innerHTML;
        let lastScreenshotTime = 0;
        const screenshotCooldown = 2000; // Don't take screenshots more than every 2 seconds

        const observer = new MutationObserver((mutations) => {
          let significantChange = false;
          
          mutations.forEach((mutation) => {
            // Check for added/removed nodes
            if (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0) {
              significantChange = true;
            }
            
            // Check for attribute changes that might affect appearance
            if (mutation.type === 'attributes' && 
                ['class', 'style', 'src', 'href'].includes(mutation.attributeName || '')) {
              significantChange = true;
            }
          });

          if (significantChange) {
            const currentContent = modalElement.innerHTML;
            const now = Date.now();
            
            if (currentContent !== lastContent && now - lastScreenshotTime > screenshotCooldown) {
              const rect = modalElement.getBoundingClientRect();
              console.log('[Modal Content Change] Detected significant change in modal:', JSON.stringify({
                modalId,
                changeType: 'content',
                timestamp: new Date().toISOString(),
                requestScreenshot: true,
                modalBounds: {
                  x: rect.left,
                  y: rect.top,
                  width: rect.width,
                  height: rect.height
                }
              }));
              
              lastContent = currentContent;
              lastScreenshotTime = now;
            }
          }
        });

        observer.observe(modalElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeOldValue: true
        });
      }

      // Function to scan for modals and start tracking - FIXED to prevent nested elements
      function scanAndTrackModals() {
        // Scanning for outermost modal elements...
        
        // Find ALL potential modal elements first
        const allModalElements: Element[] = [];
        
        // Check specific selectors
        const specificSelectors = [
          '[role="dialog"]',
          '[aria-modal="true"]',
          '.modal-content',
          '.modal-body', 
          '.modal-wrapper',
          '.dialog-content',
          '.popup-content'
        ];
        
        for (const selector of specificSelectors) {
          const elements = document.querySelectorAll(selector);
          elements.forEach(el => {
            if (isModalElement(el)) {
              allModalElements.push(el);
            }
          });
        }
        
        // Found potential modal elements
        
        // Filter to only track OUTERMOST elements (not nested children)
        const outermostModals = [];
        
        for (const element of allModalElements) {
          // Check if this element is contained within any other modal element
          let isNested = false;
          for (const otherElement of allModalElements) {
            if (otherElement !== element && otherElement.contains(element)) {
              // Skipping nested element
              isNested = true;
              break;
            }
          }
          
          if (!isNested) {
            outermostModals.push(element);
            // Tracking outermost modal
          }
        }
        
        // Track only the outermost modal elements
        outermostModals.forEach(element => {
          startTrackingModal(element);
        });
        
        // Tracking outermost modal elements
      }

      // Initial scan
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', scanAndTrackModals);
      } else {
        scanAndTrackModals();
      }

      // Periodic scan for new modals
      setInterval(scanAndTrackModals, 3000);

      // Track which components are already being monitored to prevent duplicates
      // Make these global so they persist across function calls
      if (!(window as any).monitoredComponents) {
        (window as any).monitoredComponents = new Map<string, WeakRef<Element>>();
      }
      if (!(window as any).activeObservers) {
        (window as any).activeObservers = new Map<string, MutationObserver>();
      }
      const monitoredComponents = (window as any).monitoredComponents as Map<string, WeakRef<Element>>;
      const activeObservers = (window as any).activeObservers;
      
      // Enhanced DOM monitoring for trained components with extensive debugging
      function setupTrainedComponentMonitoring() {
        // Setting up trained component monitoring
        
        const siteRules = (window as any).siteSpecificModalRules;
        // Site rules available
        
        if (!siteRules || !siteRules.trainedComponents) {
          console.log('[Trained Component Monitor] No trained components to monitor');
          return;
        }
        
        const currentPath = window.location.pathname;
        const currentUrl = window.location.href;
        // Checking current page components
        
        // Analyzing each component
        siteRules.trainedComponents.forEach((comp: any, index: number) => {
          // Component analysis completed
        });
        
        const pageComponents = siteRules.trainedComponents.filter((comp: any) => 
          comp.pagePath === currentPath || comp.pageUrl === currentUrl
        );
        
        console.log(`[Trained Component Monitor] Setting up monitoring for ${pageComponents.length} trained components`);
        // Filtered components for current page
        
        pageComponents.forEach((component: any) => {
          try {
            // Searching for elements with selector
            const elements = document.querySelectorAll(component.selector);
            // Found elements for component
            
            if (elements.length === 0) {
              // Try alternative selectors or debugging
              const allElements = document.querySelectorAll('div');
              let foundAlternative = false;
              allElements.forEach((el, idx) => {
                if (el.className && el.className.includes('styled__ModalWrapper')) {
                  // Found potential modal element
                  foundAlternative = true;
                }
              });
              if (!foundAlternative) {
                // No modal wrapper elements found
              }
            }
            
            elements.forEach((element: Element, index: number) => {
              const uniqueId = `${component.id}_${index}`;
              
              // Processing element
              
              // Check if element is visible
              const isVisible = element.getBoundingClientRect().width > 0;
              
              // Check if we're already monitoring this element
              const existingRef = monitoredComponents.get(uniqueId);
              if (existingRef) {
                const existingElement = existingRef.deref();
                if (existingElement && existingElement === element) {
                  // Element already being monitored
                  return;
                } else {
                  // Element instance changed, re-setting up
                  // Clean up old observer
                  const oldObserver = activeObservers.get(uniqueId);
                  if (oldObserver) {
                    oldObserver.disconnect();
                    activeObservers.delete(uniqueId);
                  }
                }
              }
              
              // Only monitor visible elements
              if (!isVisible) {
                // Skipping hidden element
                return;
              }
              
              // Setting up monitoring
              monitoredComponents.set(uniqueId, new WeakRef(element));
              
              // Set up click interaction monitoring only
              console.log(`[Trained Component Monitor] Found trained component: ${component.name} (${index + 1}/${elements.length})`);
              setupComponentChangeDetection(element, component, uniqueId);
            });
          } catch (error) {
            console.warn(`[Trained Component Monitor] Error setting up monitoring for ${component.name}:`, error);
          }
        });
      }
      
      // Set up change detection for a specific trained component
      function setupComponentChangeDetection(element: Element, component: any, uniqueId: string) {
        const componentId = component.id;
        let lastContent = element.innerHTML;
        let lastScreenshotTime = 0;
        const screenshotCooldown = 1500; // Reduced cooldown for better responsiveness
        
        console.log(`[Component Monitor] Setting up change detection for: ${component.name}`);
        
        // Track all interactions within the component
        ['click', 'input', 'change', 'keydown'].forEach(eventType => {
          element.addEventListener(eventType, (e) => {
            const target = e.target as Element;
            const eventInfo = {
              type: eventType,
              targetTag: target.tagName.toLowerCase(),
              targetClass: target.className,
              componentName: component.name,
              componentType: component.type,
              timestamp: new Date().toISOString()
            };
            
            console.log(`[Component Event] ${eventType} in ${component.name}:`, JSON.stringify(eventInfo));
            
            // Request screenshot for click interactions only
            if (eventType === 'click') {
              requestComponentScreenshot(element, component, 'click_interaction');
            }
          }, true);
        });
        
        // No mutation observer for content changes - only click interactions
      }
      
      // Request a screenshot of a specific component
      function requestComponentScreenshot(element: Element, component: any, reason: string) {
        const rect = element.getBoundingClientRect();
        const screenshotData = {
          componentId: component.id,
          componentName: component.name,
          componentType: component.type,
          selector: component.selector,
          reason: reason,
          timestamp: new Date().toISOString(),
          bounds: {
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height
          },
          requestScreenshot: true
        };
        
        // Send screenshot request in the format expected by the server
        console.log('[Component Screenshot] Requesting screenshot:', JSON.stringify(screenshotData));
        
        // Also ensure element is visible and valid
        if (rect.width > 0 && rect.height > 0) {
          console.log(`[Component Debug] Screenshot requested for ${component.name} (${reason}) - Element visible: ${rect.width}x${rect.height}`);
        } else {
          console.warn(`[Component Debug] Screenshot requested for ${component.name} but element has no dimensions: ${rect.width}x${rect.height}`);
        }
      }
      
      // Set up trained component monitoring with debugging
      if ((window as any).siteSpecificModalRules) {
        setupTrainedComponentMonitoring();
      }
      
      // Re-setup monitoring when rules are updated
      (window as any).refreshComponentMonitoring = function() {
        // Refreshing component monitoring
        setupTrainedComponentMonitoring();
      };
      
      // Manual trigger for debugging
      (window as any).manualTriggerMonitoring = function() {
        console.log('[MANUAL DEBUG] Manually triggering component monitoring...');
        console.log('[MANUAL DEBUG] Site rules available:', !!(window as any).siteSpecificModalRules);
        if ((window as any).siteSpecificModalRules) {
          console.log('[MANUAL DEBUG] Rules:', (window as any).siteSpecificModalRules);
        }
        setupTrainedComponentMonitoring();
      };
      
      // Manual element finder for debugging
      (window as any).findModalElements = function() {
        console.log('[MANUAL DEBUG] Searching for modal elements...');
        const selector = '.styled__ModalWrapper-sc-7eym6d-0';
        const elements = document.querySelectorAll(selector);
        console.log(`[MANUAL DEBUG] Found ${elements.length} elements with selector ${selector}`);
        elements.forEach((el, i) => {
          console.log(`[MANUAL DEBUG] Element ${i}:`, {
            className: el.className,
            tagName: el.tagName,
            visible: el.getBoundingClientRect().width > 0,
            rect: el.getBoundingClientRect()
          });
        });
        return elements;
      };
      
      // Toggle debug mode
      (window as any).toggleModalDebug = function(enabled?: boolean) {
        if (enabled === undefined) {
          (window as any).debugModalTracking = !(window as any).debugModalTracking;
        } else {
          (window as any).debugModalTracking = enabled;
        }
        console.log(`[Modal Debug] Debug mode is now ${(window as any).debugModalTracking ? 'ON' : 'OFF'}`);
        return (window as any).debugModalTracking;
      };
      
      // Periodic check for trained components (in case they appear later)
      let lastComponentCount = 0;
      let lastModalCheckTime = 0;
      const modalCheckInterval = 2000; // Check every 2 seconds
      
      setInterval(() => {
        const now = Date.now();
        if ((window as any).siteSpecificModalRules) {
          const siteRules = (window as any).siteSpecificModalRules;
          const currentPath = window.location.pathname;
          const pageComponents = siteRules.trainedComponents ? siteRules.trainedComponents.filter((comp: any) => 
            comp.pagePath === currentPath || comp.pageUrl === window.location.href
          ) : [];
          
          // Check if any trained components are visible on the page
          let visibleComponents = 0;
          let needsResetup = false;
          
          pageComponents.forEach((component: any) => {
            const elements = document.querySelectorAll(component.selector);
            // Removed console logging for cleaner output
            
            // If no elements found, clear monitoring for this component
            if (elements.length === 0) {
              // Clear all monitoring for this component
              for (let i = 0; i < 10; i++) { // Assume max 10 instances
                const uniqueId = `${component.id}_${i}`;
                monitoredComponents.delete(uniqueId);
                const observer = activeObservers.get(uniqueId);
                if (observer) {
                  observer.disconnect();
                  activeObservers.delete(uniqueId);
                }
              }
            }
            
            elements.forEach((el: Element, idx: number) => {
              const rect = el.getBoundingClientRect();
              const isVisible = rect.width > 0 && rect.height > 0;
              const uniqueId = `${component.id}_${idx}`;
              // Check if element is actually being monitored
              let isMonitored = false;
              const ref = monitoredComponents.get(uniqueId);
              if (ref) {
                const trackedElement = ref.deref();
                isMonitored = trackedElement === el;
              }
              
              if ((window as any).debugModalTracking) {
                console.log(`[PERIODIC CHECK] Element ${idx}: visible=${isVisible}, monitored=${isMonitored}, size=${rect.width}x${rect.height}`);
              }
              
              if (isVisible) {
                visibleComponents++;
                if (!isMonitored) {
                  needsResetup = true;
                  console.log(`[PERIODIC CHECK] Found unmonitored visible component: ${component.name} - triggering immediate setup`);
                  
                  // Immediately set up monitoring for this element
                  monitoredComponents.set(uniqueId, new WeakRef(el));
                  requestComponentScreenshot(el, component, 'modal_opened');
                  setupComponentChangeDetection(el, component, uniqueId);
                }
              }
            });
          });
          
          // Re-scan if we found visible components that aren't being monitored
          if (needsResetup && (now - lastModalCheckTime > modalCheckInterval)) {
            console.log(`[Trained Component Monitor] Found ${visibleComponents} visible components, ${needsResetup ? 'NEEDS RESETUP' : 'all monitored'}`);
            lastModalCheckTime = now;
            setupTrainedComponentMonitoring();
          }
        }
      }, 2000);

      // Also scan when DOM changes significantly
      const globalObserver = new MutationObserver((mutations) => {
        let shouldScan = false;
        
        mutations.forEach((mutation) => {
          if (mutation.addedNodes.length > 0) {
            mutation.addedNodes.forEach((node) => {
              if (node.nodeType === Node.ELEMENT_NODE) {
                const element = node as Element;
                // Check if the added element or its children might be modals
                if (element.querySelectorAll && 
                    (element.querySelectorAll('[class*="modal"]').length > 0 ||
                     element.querySelectorAll('[role="dialog"]').length > 0 ||
                     isModalElement(element))) {
                  shouldScan = true;
                }
              }
            });
          }
        });

        if (shouldScan) {
          setTimeout(scanAndTrackModals, 500); // Delay to let DOM settle
        }
      });

      globalObserver.observe(document.body, {
        childList: true,
        subtree: true
      });
    });

    console.log('[Modal Tracker] Modal interaction tracking enabled');
    // Modal tracking script injection completed
  }

  // Process modal-related console messages
  private async processModalConsoleMessages(consoleMessage: string) {
    try {
      // Handle modal training data
      if (consoleMessage.includes('[Modal Training] Element selected for training:')) {
        await this.storeModalTrainingData(consoleMessage);
        return;
      }

      // Handle modal interaction tracking
      if (consoleMessage.includes('[Modal Interaction]')) {
        await this.recordModalInteraction(consoleMessage);
        return;
      }

      // Handle modal content changes with automatic screenshot
      if (consoleMessage.includes('[Modal Content Change]') && consoleMessage.includes('requestScreenshot: true')) {
        await this.handleModalContentChange(consoleMessage);
        return;
      }

      // Handle modal tracker events
      if (consoleMessage.includes('[Modal Tracker] Started tracking modal:')) {
        await this.recordModalTrackingStart(consoleMessage);
        return;
      }

      // Handle component screenshot requests
      if (consoleMessage.includes('[Component Screenshot] Requesting screenshot:')) {
        await this.handleComponentScreenshotRequest(consoleMessage);
        return;
      }
      
      // Handle clicks within trained components - DISABLED to prevent duplicates
      // The browser-injected script already handles click screenshots
      // if (consoleMessage.includes('[Component Event] click in')) {
      //   await this.handleTrainedComponentClick(consoleMessage);
      //   return;
      // }

    } catch (error) {
      console.error('[Modal Console Processing] Error processing modal console message:', error);
    }
  }

  // Record modal interaction events
  private async recordModalInteraction(consoleMessage: string) {
    // ALLOW screenshots during training mode for testing - just don't save to recording session
    const skipRecording = this.isTrainingMode;
    if (skipRecording) {
      console.log(`[Modal Training] Taking screenshot for testing but not recording to session`);
    }

    if (!this.recordingSession && !skipRecording) return;

    try {
      // Extract interaction data from console message
      const interactionMatch = consoleMessage.match(/\[Modal Interaction\] (\w+) tracked: (.+)/);
      if (!interactionMatch) return;

      const [, interactionType, dataStr] = interactionMatch;
      const interactionData = JSON.parse(dataStr);

      // Modal interaction detected

      // Take ONE screenshot per interaction
      let screenshotFilename = null;
      try {
        screenshotFilename = await this.takeProperModalScreenshot(interactionData.modalId);
        console.log(`[Modal Screenshot] Screenshot saved: ${screenshotFilename}`);
      } catch (error) {
        console.error('[Modal Screenshot] Screenshot failed:', error);
      }

      // Create modal interaction record
      const interactionRecord = {
        type: 'modal_interaction' as const,
        from_url: this.currentUrl,
        to_url: this.currentUrl,
        actions: [{
          action_description: `Modal ${interactionType}: ${interactionData.modalId}`,
          screenshot: screenshotFilename || undefined
        }]
      };

      // Only record to session if not in training mode
      if (!skipRecording) {
        await this.recordAction(interactionRecord);
        console.log(`[Modal Interaction] Recorded ${interactionType} interaction for modal: ${interactionData.modalId}`);
      } else {
        console.log(`[Modal Training] Screenshot taken for testing: ${screenshotFilename} (not saved to recording)`);
      }

    } catch (error) {
      console.error('[Modal Interaction] Error recording modal interaction:', error);
    }
  }

  // Handle modal content changes - LOG ONLY, NO SCREENSHOTS
  private async handleModalContentChange(consoleMessage: string) {
    try {
      const changeMatch = consoleMessage.match(/\[Modal Content Change\] Detected significant change in modal: (.+)/);
      if (!changeMatch) return;

      const changeData = JSON.parse(changeMatch[1]);
      // Content change detected for modal
      
      // DO NOT TAKE SCREENSHOTS FOR CONTENT CHANGES - only log them
      console.log(`[Modal Content Change] Logged content change for modal: ${changeData.modalId} (NO SCREENSHOT)`);
      
    } catch (error) {
      console.error('[Modal Content Change] Error processing content change:', error);
    }
  }

  // Take a proper modal screenshot with simple, clear logic  
  private async takeProperModalScreenshot(modalId: string): Promise<string> {
    if (!this.page || !this.recordingSession) {
      throw new Error('No page or recording session available');
    }

    // Skip modal screenshots when in training mode
    if (this.isTrainingMode) {
      console.log(`[Training Mode] Skipping modal screenshot: ${modalId}`);
      return `training_mode_skip_${Date.now()}.png`;
    }

    const filename = `modal_${modalId.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}.png`;
    const screenshotPath = path.join(process.cwd(), 'recordings', `session_${this.recordingSession.id}`, filename);
    
    // Ensure directory exists
    await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
    
    // Looking for modal element to screenshot
    
    // First try to find the specific modal that matches the trained one
    let modalElement = null;
    
    // Try to find the trained modal element
    if (modalId.includes('styled__ModalWrapper-sc-7eym6d-0')) {
      // Looking for trained modal
      modalElement = await this.page.$('.styled__ModalWrapper-sc-7eym6d-0');
    }
    
    // If not found, try other common modal selectors
    if (!modalElement) {
      // Trying other modal selectors
      modalElement = await this.page.$('[role="dialog"], [aria-modal="true"], .modal-content, .modal-body, .modal-wrapper');
    }
    
    if (modalElement) {
      await modalElement.screenshot({ path: screenshotPath });
      console.log(`[Modal Screenshot] Element screenshot saved: ${filename}`);
    } else {
      await this.page.screenshot({ path: screenshotPath });
      console.log(`[Modal Screenshot] Viewport screenshot saved: ${filename}`);
    }
    
    return filename;
  }

  // Handle component screenshot requests from browser with comprehensive deduplication
  private recentScreenshots = new Map<string, number>(); // Track recent screenshots to prevent duplicates
  private screenshotQueue = new Set<string>(); // Track currently processing screenshots
  
  private async handleComponentScreenshotRequest(consoleMessage: string) {
    try {
      const screenshotMatch = consoleMessage.match(/\[Component Screenshot\] Requesting screenshot: (.+)/);
      if (!screenshotMatch) return;

      const screenshotData = JSON.parse(screenshotMatch[1]);
      
      // Create comprehensive unique key for deduplication
      const screenshotKey = `${screenshotData.componentId}_${screenshotData.reason}_${screenshotData.selector || 'unknown'}`;
      const now = Date.now();
      const lastScreenshot = this.recentScreenshots.get(screenshotKey);
      
      // Check if this screenshot is already being processed
      if (this.screenshotQueue.has(screenshotKey)) {
        console.log(`[Component Screenshot] Screenshot already in progress for ${screenshotData.componentName} (${screenshotData.reason})`);
        return;
      }
      
      // Prevent duplicate screenshots within 3 seconds
      if (lastScreenshot && (now - lastScreenshot) < 3000) {
        console.log(`[Component Screenshot] Skipping duplicate screenshot for ${screenshotData.componentName} (${screenshotData.reason}) - last taken ${now - lastScreenshot}ms ago`);
        return;
      }
      
      this.screenshotQueue.add(screenshotKey);
      this.recentScreenshots.set(screenshotKey, now);
      
      console.log(`[Component Screenshot] Processing request for: ${screenshotData.componentName} (${screenshotData.reason})`);

      if (!this.page || !this.recordingSession) {
        console.log('[Component Screenshot] No page or recording session available');
        return;
      }

      // Generate filename based on component
      const timestamp = Date.now();
      const safeComponentName = screenshotData.componentName.replace(/[^a-zA-Z0-9]/g, '_');
      const filename = `component_${safeComponentName}_${screenshotData.reason}_${timestamp}.png`;
      const screenshotPath = path.join(process.cwd(), 'recordings', `session_${this.recordingSession.id}`, filename);
      
      // Ensure directory exists
      await fs.mkdir(path.dirname(screenshotPath), { recursive: true });

      try {
        // Find the component element and take screenshot with zoom consideration
        const componentSelector = await this.getComponentSelector(screenshotData.componentId) || screenshotData.selector;
        if (componentSelector) {
          try {
            await this.takeZoomAwareComponentScreenshot(componentSelector, screenshotPath, screenshotData);
            console.log(`[Component Screenshot] Saved: ${filename} for ${screenshotData.componentName}`);
            
            // Add to recording session
            this.recordingSession.screenshots.push(filename);
            
            // Create action record
            const actionRecord = {
              type: 'modal_content_change' as const,
              from_url: this.currentUrl,
              to_url: this.currentUrl,
              actions: [{
                action_description: `${screenshotData.componentName} - ${screenshotData.reason}`,
                screenshot: filename
              }]
            };
            
            await this.recordAction(actionRecord);
          } catch (error) {
            console.error(`[Component Screenshot] Error taking screenshot for ${screenshotData.componentName}:`, error);
          }
        } else {
          console.warn(`[Component Screenshot] No selector found for component ${screenshotData.componentId}`);
        }
      } finally {
        // Remove from processing queue
        this.screenshotQueue.delete(screenshotKey);
      }
      
    } catch (error) {
      console.error('[Component Screenshot] Error processing screenshot request:', error);
    }
  }

  // Take screenshot of component accounting for zoom levels and ensuring full modal capture
  private async takeZoomAwareComponentScreenshot(selector: string, screenshotPath: string, screenshotData: any) {
    if (!this.page) throw new Error('No page available');

    // Skip component screenshots when in training mode
    if (this.isTrainingMode) {
      console.log(`[Training Mode] Skipping component screenshot: ${screenshotData.componentName}`);
      return;
    }

    const componentElement = await this.page.$(selector);
    if (!componentElement) {
      console.warn(`[Component Screenshot] Element not found for selector: ${selector}`);
      return;
    }

    // Get comprehensive zoom and element information using the proven area capture method
    const elementInfo = await this.page.evaluate((sel) => {
      const element = document.querySelector(sel);
      if (!element) return null;

      const rect = element.getBoundingClientRect();
      const computedStyle = window.getComputedStyle(element);
      
      // Use the same zoom calculation as the working area capture
      const zoomLevel = window.devicePixelRatio / (window.visualViewport?.scale || 1);
      
      // Adjust coordinates for browser zoom level (same as area capture)
      const adjustedX = Math.round(rect.left * zoomLevel);
      const adjustedY = Math.round(rect.top * zoomLevel);
      const adjustedWidth = Math.round(rect.width * zoomLevel);
      const adjustedHeight = Math.round(rect.height * zoomLevel);
      
      return {
        bounds: {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height
        },
        adjustedBounds: {
          x: adjustedX,
          y: adjustedY,
          width: adjustedWidth,
          height: adjustedHeight
        },
        zoomLevel,
        viewportScale: window.visualViewport?.scale || 1,
        devicePixelRatio: window.devicePixelRatio,
        isVisible: rect.width > 0 && rect.height > 0 && computedStyle.visibility !== 'hidden' && computedStyle.display !== 'none',
        position: computedStyle.position,
        zIndex: computedStyle.zIndex
      };
    }, selector);

    if (!elementInfo) {
      console.warn(`[Component Screenshot] Could not get element info for: ${selector}`);
      return;
    }

    if (!elementInfo.isVisible) {
      console.warn(`[Component Screenshot] Element is not visible: ${selector}`);
      return;
    }

    console.log(`[Component Screenshot] Element info for ${screenshotData.componentName}:`, {
      selector,
      bounds: elementInfo.bounds,
      adjustedBounds: elementInfo.adjustedBounds,
      zoomLevel: elementInfo.zoomLevel,
      position: elementInfo.position,
      zIndex: elementInfo.zIndex
    });

    try {
      // Scroll element into view to ensure it's fully visible
      await componentElement.scrollIntoViewIfNeeded();
      
      // Use the zoom-adjusted bounds (same approach as working area capture)
      const clipBounds = {
        x: Math.max(0, elementInfo.adjustedBounds.x),
        y: Math.max(0, elementInfo.adjustedBounds.y),
        width: elementInfo.adjustedBounds.width,
        height: elementInfo.adjustedBounds.height
      };
      
      console.log(`[Component Screenshot] Using zoom-adjusted clip bounds:`, clipBounds);
      
      if (clipBounds.width > 0 && clipBounds.height > 0) {
        // Take screenshot using the same method as the working area capture
        await this.page.screenshot({
          path: screenshotPath,
          type: 'png',
          clip: clipBounds,
          animations: 'disabled'
        });
        
        console.log(`[Component Screenshot] Successfully captured zoom-adjusted screenshot for ${screenshotData.componentName} (${clipBounds.width}x${clipBounds.height})`);
      } else {
        throw new Error('Invalid zoom-adjusted clip bounds');
      }
    } catch (screenshotError) {
      console.error(`[Component Screenshot] Failed to capture area screenshot:`, screenshotError);
      
      // Fallback to element screenshot method
      try {
        await componentElement.screenshot({ 
          path: screenshotPath,
          type: 'png',
          animations: 'disabled'
        });
        console.log(`[Component Screenshot] Fallback element screenshot captured for ${screenshotData.componentName}`);
      } catch (elementError) {
        console.error(`[Component Screenshot] Element screenshot also failed:`, elementError);
        
        // Final fallback to full page screenshot
        await this.page.screenshot({ 
          path: screenshotPath,
          type: 'png',
          fullPage: true
        });
        console.log(`[Component Screenshot] Final fallback full page screenshot captured`);
      }
    }
  }

  // Get component selector by ID
  private async getComponentSelector(componentId: string): Promise<string | null> {
    if (!this.currentSiteDomain) return null;
    
    try {
      const rules = await this.getSiteParsingRules();
      if (rules && rules.trainedComponents) {
        const component = rules.trainedComponents.find((comp: any) => comp.id === componentId);
        return component ? component.selector : null;
      }
    } catch (error) {
      console.error('[Component Screenshot] Error getting selector:', error);
    }
    
    return null;
  }

  // Take screenshot for modal interactions (OLD FUNCTION - KEEPING FOR NOW)
  private async takeModalInteractionScreenshot(modalId: string, targetInfo: any): Promise<string> {
    if (!this.page || !this.recordingSession) {
      throw new Error('No page or recording session available');
    }

    try {
      const filename = `modal_interaction_${modalId.replace(/[^a-zA-Z0-9]/g, '_')}_${this.modalScreenshotIndex++}.png`;
      const screenshotPath = path.join(process.cwd(), 'recordings', `session_${this.recordingSession.id}`, filename);
      
      // Ensure directory exists
      await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
      
      // Try to find a modal element - use a much simpler approach
      const modalInfo = await this.page.evaluate(() => {
        // Look for visible modal elements with very specific criteria
        const possibleModals = [
          ...Array.from(document.querySelectorAll('[role="dialog"]')),
          ...Array.from(document.querySelectorAll('[aria-modal="true"]')),
          ...Array.from(document.querySelectorAll('.modal-content, .modal-body, .dialog-content')),
          ...Array.from(document.querySelectorAll('div[style*="position: fixed"], div[style*="position:fixed"]'))
        ];
        
        console.log(`[Modal Screenshot] Found ${possibleModals.length} possible modal elements`);
        
        for (const element of possibleModals) {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          
          // Log each candidate
          console.log(`[Modal Screenshot] Checking element:`, {
            tagName: element.tagName,
            className: element.className,
            id: element.id,
            position: style.position,
            zIndex: style.zIndex,
            width: rect.width,
            height: rect.height,
            visible: rect.width > 0 && rect.height > 0
          });
          
          // Must be visible and reasonably sized (not full screen)
          if (rect.width > 100 && rect.height > 100 && 
              rect.width < window.innerWidth * 0.95 && 
              rect.height < window.innerHeight * 0.95 &&
              rect.left >= 0 && rect.top >= 0) {
            
            // Double check the bounds are valid
            const validBounds = rect.left >= 0 && rect.top >= 0 &&
                               rect.left + rect.width <= window.innerWidth &&
                               rect.top + rect.height <= window.innerHeight;
            
            if (!validBounds) {
              console.log(`[Modal Screenshot] Element has invalid bounds, skipping:`, {
                bounds: rect,
                viewport: { width: window.innerWidth, height: window.innerHeight }
              });
              continue;
            }
            
            console.log(`[Modal Screenshot] Selected modal element:`, {
              tagName: element.tagName,
              className: element.className,
              bounds: rect,
              valid: validBounds
            });
            
            return {
              found: true,
              bounds: {
                x: Math.max(0, Math.floor(rect.left)),
                y: Math.max(0, Math.floor(rect.top)),
                width: Math.floor(rect.width),
                height: Math.floor(rect.height)
              }
            };
          }
        }
        
        console.log('[Modal Screenshot] No suitable modal found, will use viewport');
        return { found: false };
      });

      if (modalInfo.found && modalInfo.bounds) {
        // Validate clip bounds before using them
        const bounds = modalInfo.bounds;
        const viewportSize = await this.page.viewportSize();
        
        console.log(`[Modal Screenshot] Validating bounds:`, bounds);
        console.log(`[Modal Screenshot] Viewport size:`, viewportSize);
        
        const isValidBounds = bounds.width > 0 && bounds.height > 0 && 
                             bounds.x >= 0 && bounds.y >= 0 &&
                             bounds.x + bounds.width <= (viewportSize?.width || 1920) &&
                             bounds.y + bounds.height <= (viewportSize?.height || 1080);
        
        if (isValidBounds) {
          // Take screenshot using clip bounds
          await this.page.screenshot({
            path: screenshotPath,
            type: 'png',
            clip: bounds
          });
          console.log(`[Modal Interaction] Modal clip screenshot captured: ${filename} (${bounds.width}x${bounds.height})`);
        } else {
          console.log(`[Modal Screenshot] Invalid bounds detected, using viewport screenshot instead`);
          // Fallback to viewport screenshot
          await this.page.screenshot({
            path: screenshotPath,
            type: 'png'
          });
          console.log(`[Modal Interaction] Viewport screenshot captured (invalid bounds): ${filename}`);
        }
      } else {
        // Fallback to viewport screenshot
        await this.page.screenshot({
          path: screenshotPath,
          type: 'png'
        });
        console.log(`[Modal Interaction] Viewport screenshot captured (modal not found): ${filename}`);
      }

      return filename;

    } catch (error) {
      console.error('[Modal Interaction] Error taking modal interaction screenshot:', error);
      return `error_${Date.now()}.png`;
    }
  }

  // Take screenshot specifically for modal content changes
  private async takeModalChangeScreenshot(modalId: string, modalBounds?: { x: number; y: number; width: number; height: number }): Promise<string> {
    if (!this.page || !this.recordingSession) {
      throw new Error('No page or recording session available');
    }

    try {
      const filename = `modal_change_${modalId.replace(/[^a-zA-Z0-9]/g, '_')}_${this.modalScreenshotIndex++}.png`;
      const screenshotPath = path.join(process.cwd(), 'recordings', `session_${this.recordingSession.id}`, filename);
      
      // Ensure directory exists
      await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
      
      if (modalBounds && modalBounds.width > 0 && modalBounds.height > 0) {
        // Take screenshot of only the modal area
        await this.page.screenshot({
          path: screenshotPath,
          type: 'png',
          clip: {
            x: modalBounds.x,
            y: modalBounds.y,
            width: modalBounds.width,
            height: modalBounds.height
          }
        });
        console.log(`[Modal Content Change] Modal-only screenshot captured: ${filename} (${modalBounds.width}x${modalBounds.height})`);
      } else {
        // Fallback to viewport screenshot if no bounds available
        await this.page.screenshot({
          path: screenshotPath,
          type: 'png'
        });
        console.log(`[Modal Content Change] Viewport screenshot captured: ${filename} (no modal bounds available)`);
      }

      return filename;

    } catch (error) {
      console.error('[Modal Content Change] Error taking modal change screenshot:', error);
      return `error_${Date.now()}.png`;
    }
  }

  // Record when modal tracking starts
  private async recordModalTrackingStart(consoleMessage: string) {
    // Don't record tracking starts during training mode
    if (this.isTrainingMode) {
      console.log(`[Modal Training] Skipping tracking start recording in training mode`);
      return;
    }

    if (!this.recordingSession) return;

    try {
      // Extract modal ID from console message
      const trackingMatch = consoleMessage.match(/\[Modal Tracker\] Started tracking modal: (.+)/);
      if (!trackingMatch) return;

      const modalId = trackingMatch[1];

      // Record that we started tracking this modal
      const trackingRecord = {
        type: 'modal_tracking_start' as const,
        from_url: this.currentUrl,
        to_url: this.currentUrl,
        actions: [{
          action_description: `Started tracking modal: ${modalId}`,
          modal_id: modalId,
          timestamp: new Date().toISOString()
        }]
      };

      await this.recordAction(trackingRecord);
      console.log(`[Modal Tracking] Recorded start of tracking for modal: ${modalId}`);

    } catch (error) {
      console.error('[Modal Tracking] Error recording modal tracking start:', error);
    }
  }

  // Public methods for controlling training mode
  enableTrainingMode() {
    this.isTrainingMode = true;
    console.log(`[Modal Training] Training mode ENABLED for ${this.currentSiteDomain} (Session: ${this.sessionId})`);
    this.updateTrainingModeIndicator();
  }

  disableTrainingMode() {
    this.isTrainingMode = false;
    console.log(`[Modal Training] Training mode DISABLED for ${this.currentSiteDomain} (Session: ${this.sessionId})`);
    this.updateTrainingModeIndicator();
  }

  isInTrainingMode(): boolean {
    return this.isTrainingMode;
  }

  // Update the training mode indicator in the browser overlay
  private async updateTrainingModeIndicator() {
    if (!this.page) return;

    try {
      await this.page.evaluate((isTrainingMode) => {
        // Update global state
        (window as any).__crawlerTrainingMode = isTrainingMode;
        
        const indicator = document.getElementById('training-mode-indicator');
        console.log('[Training Mode Indicator] Element exists:', !!indicator);
        if (indicator) {
          indicator.style.background = isTrainingMode ? '#e74c3c' : '#27ae60';
          indicator.style.borderColor = isTrainingMode ? '#c0392b' : '#229954';
          indicator.textContent = isTrainingMode ? '📚 TRAINING MODE' : '🎥 RECORDING MODE';
          console.log('[Training Mode Indicator] Updated to:', indicator.textContent);
        } else {
          console.log('[Training Mode Indicator] Not found in DOM - overlay may need re-injection');
        }
      }, this.isTrainingMode);
    } catch (error) {
      console.error('[Training Mode Indicator] Error updating:', error);
    }
  }

  getCurrentDomain(): string {
    return this.currentSiteDomain;
  }
  
  // Playwright-based component monitoring
  private trainedComponentInterval: NodeJS.Timeout | null = null;
  private monitoredElements = new Map<string, any>(); // uniqueId -> monitoring info
  private componentIntervals = new Map<string, NodeJS.Timeout>(); // uniqueId -> content check interval
  
  private async startPlaywrightComponentMonitoring() {
    if (!this.page || this.trainedComponentInterval) return;
    
    
    // Check for trained components every second
    this.trainedComponentInterval = setInterval(async () => {
      if (!this.page || !this.currentSiteDomain) return;
      
      try {
        const rules = await this.getSiteParsingRules();
        if (!rules || !rules.trainedComponents) return;
        
        // Filter components for current page
        const currentPath = new URL(this.currentUrl).pathname;
        const pageComponents = rules.trainedComponents.filter((comp: any) => 
          comp.pagePath === currentPath || comp.pageUrl === this.currentUrl
        );
        
        if (pageComponents.length === 0) return;
        
        // Check each component
        for (const component of pageComponents) {
          try {
            // Use Playwright to check if elements exist
            const elements = await this.page.$$(component.selector);
            
            for (let i = 0; i < elements.length; i++) {
              const uniqueId = `${component.id}_${i}`;
              const element = elements[i];
              
              // Check if element is visible
              const isVisible = await element.isVisible();
              if (!isVisible) continue;
              
              // Check if we're already monitoring this element
              if (!this.monitoredElements.has(uniqueId)) {
                this.monitoredElements.set(uniqueId, { component, lastContent: '', lastClickTime: 0 });
                
                // Only set up monitoring - no initial screenshot
              }
            }
            
            // Clean up disappeared elements
            const currentIds = new Set(elements.map((_, i) => `${component.id}_${i}`));
            for (const [id] of this.monitoredElements) {
              if (id.startsWith(component.id) && !currentIds.has(id)) {
                this.monitoredElements.delete(id);
                // Clean up interval
                const interval = this.componentIntervals.get(id);
                if (interval) {
                  clearInterval(interval);
                  this.componentIntervals.delete(id);
                }
              }
            }
            
          } catch (error) {
          }
        }
      } catch (error) {
        // Ignore errors silently
      }
    }, 1000);
  }
  
  private async takeComponentScreenshot(element: any, component: any, reason: string) {
    if (!this.recordingSession) return;
    
    try {
      const timestamp = Date.now();
      const safeComponentName = component.name.replace(/[^a-zA-Z0-9]/g, '_');
      const filename = `component_${safeComponentName}_${reason}_${timestamp}.png`;
      const screenshotPath = path.join(process.cwd(), 'recordings', `session_${this.recordingSession.id}`, filename);
      
      // Use Playwright's element screenshot
      await element.screenshot({ path: screenshotPath });
      
      
      // Add to recording session
      this.recordingSession.screenshots.push(filename);
      
      // Create action record
      await this.recordAction({
        type: 'modal_content_change',
        from_url: this.currentUrl,
        to_url: this.currentUrl,
        actions: [{
          action_description: `${component.name} - ${reason}`,
          screenshot: filename
        }]
      });
    } catch (error) {
    }
  }
  
  // Handle clicks within trained components and take screenshots
  private async handleTrainedComponentClick(consoleMessage: string) {
    try {
      // Extract component event data
      const eventMatch = consoleMessage.match(/\[Component Event\] click in (.+): (.+)/);
      if (!eventMatch) return;
      
      const [, componentName, eventDataStr] = eventMatch;
      const eventData = JSON.parse(eventDataStr);
      
      
      // Find the component in our monitoring list
      for (const [uniqueId, monitoringInfo] of this.monitoredElements) {
        if (monitoringInfo.component.name === componentName) {
          const now = Date.now();
          
          // Prevent duplicate screenshots within 2 seconds
          if (now - monitoringInfo.lastClickTime < 2000) {
            return;
          }
          
          monitoringInfo.lastClickTime = now;
          
          // Get fresh element reference and take screenshot
          const elements = await this.page!.$$(monitoringInfo.component.selector);
          const elementIndex = parseInt(uniqueId.split('_').pop() || '0');
          const element = elements[elementIndex];
          
          if (element && await element.isVisible()) {
            await this.takeComponentScreenshot(element, monitoringInfo.component, 'click_interaction');
          }
          break;
        }
      }
    } catch (error) {
    }
  }

  // Get site-specific parsing rules
  async getSiteParsingRules(): Promise<any> {
    if (!this.currentSiteDomain) return null;

    const rulesFile = path.join(process.cwd(), 'modal-parsing-rules', `${this.currentSiteDomain}.json`);
    
    try {
      const rulesContent = await fs.readFile(rulesFile, 'utf-8');
      return JSON.parse(rulesContent);
    } catch (error) {
      return null;
    }
  }
  
  // Delete a specific trained component
  async deleteTrainedComponent(componentId: string): Promise<boolean> {
    if (!this.currentSiteDomain) return false;
    
    const rulesFile = path.join(process.cwd(), 'modal-parsing-rules', `${this.currentSiteDomain}.json`);
    
    try {
      const rulesContent = await fs.readFile(rulesFile, 'utf-8');
      const siteRules = JSON.parse(rulesContent);
      
      // Find and remove the component
      const originalLength = siteRules.trainedComponents.length;
      siteRules.trainedComponents = siteRules.trainedComponents.filter(
        (comp: any) => comp.id !== componentId
      );
      
      if (siteRules.trainedComponents.length < originalLength) {
        // Component was found and removed
        siteRules.lastUpdated = new Date().toISOString();
        siteRules.version++;
        
        await fs.writeFile(rulesFile, JSON.stringify(siteRules, null, 2));
        
        // Reload rules in browser
        await this.loadAndApplySiteRules();
        
        console.log(`[Modal Rules] Deleted component: ${componentId}`);
        return true;
      }
      
      return false;
    } catch (error) {
      console.error('[Modal Rules] Error deleting component:', error);
      return false;
    }
  }

  // Inject comprehensive monitoring scripts on page load
  private async injectMonitoringScripts() {
    if (!this.page) return;
    
    console.log('[Navigation] Injecting comprehensive monitoring scripts...');
    
    try {
      // Wait for page to be ready
      await this.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {
        console.log('[Navigation] DOM content loaded timeout, continuing...');
      });
      
      // Re-inject the modal detection and monitoring script
      await this.enableModalInteractionTracking();
      
      // Re-apply site rules
      await this.loadAndApplySiteRules();
      
      console.log('[Navigation] Monitoring scripts injected successfully');
    } catch (error) {
      console.error('[Navigation] Error injecting monitoring scripts:', error);
    }
  }
  
  // Re-inject monitoring scripts after navigation
  private async reinjectMonitoringScripts() {
    if (!this.page) return;
    
    console.log('[Navigation] Re-injecting monitoring scripts after navigation...');
    
    try {
      // Wait for the page to be fully loaded and interactive
      await this.page.waitForLoadState('domcontentloaded');
      
      // Ensure document.body exists before injecting
      await this.page.waitForFunction(() => document.body !== null);
      
      // Re-inject all monitoring
      await this.injectMonitoringScripts();
      
      // Re-inject debug overlay after navigation with current training mode state
      await this.injectDebugOverlayDirect();
      
      console.log('[Navigation] Monitoring scripts re-injected successfully');
    } catch (error) {
      console.error('[Navigation] Error re-injecting monitoring scripts:', error);
    }
  }

  async cleanup() {
    // Clean up intervals
    if (this.trainedComponentInterval) {
      clearInterval(this.trainedComponentInterval);
      this.trainedComponentInterval = null;
    }
    if (this.modalCheckInterval) {
      clearInterval(this.modalCheckInterval);
      this.modalCheckInterval = null;
    }
    
    // Clean up component monitoring intervals
    for (const interval of this.componentIntervals.values()) {
      clearInterval(interval);
    }
    this.componentIntervals.clear();
    this.monitoredElements.clear();
    
    if (this.page) {
      await this.page.close();
      this.page = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    await this.browserManager.cleanup();
  }

  private generateSlugFromUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      // Create a cleaner slug from path only
      let slug = urlObj.pathname;
      
      // Remove leading/trailing slashes and replace with meaningful names
      slug = slug.replace(/^\/+|\/+$/g, '');
      
      // Handle root path
      if (!slug || slug === '') {
        slug = 'home';
      }
      
      // Replace slashes and special chars with hyphens
      slug = slug
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/--+/g, '-');
      
      return slug || 'page';
    } catch (error) {
      return 'unknown-page';
    }
  }

  private async discoverLinks(): Promise<DiscoveredLink[]> {
    if (!this.page || !this.isRecording) return [];
    
    try {
      if (this.page.isClosed()) {
        return [];
      }
    } catch (error) {
      return [];
    }

    try {
      return await this.page.evaluate(() => {
        const links: DiscoveredLink[] = [];
        const currentOrigin = window.location.origin;

        // Helper function to get element selector
        function getSelector(element: Element): string {
          if (element.id) return `#${element.id}`;
          if (element.className) {
            const classes = element.className.split(' ').filter(c => c.length > 0);
            if (classes.length > 0) return `.${classes.join('.')}`;
          }
          return element.tagName.toLowerCase();
        }

        // Helper function to get element position
        function getPosition(element: Element): { x: number; y: number } {
          const rect = element.getBoundingClientRect();
          return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2
          };
        }

        // Find all anchor tags
        const anchors = document.querySelectorAll('a[href]');
        anchors.forEach(anchor => {
          const href = anchor.getAttribute('href');
          if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;

          const absoluteHref = href.startsWith('http') ? href : new URL(href, window.location.href).href;
          const text = anchor.textContent?.trim() || '';
          const title = anchor.getAttribute('title') || undefined;

          links.push({
            href: absoluteHref,
            text,
            title,
            element_type: 'a',
            selector: getSelector(anchor),
            position: getPosition(anchor),
            is_internal: absoluteHref.startsWith(currentOrigin),
            is_button: false
          });
        });

        // Find clickable buttons with onclick or data attributes that might navigate
        const buttons = document.querySelectorAll('button, [role="button"]');
        buttons.forEach(button => {
          const onclick = button.getAttribute('onclick');
          const dataHref = button.getAttribute('data-href') || button.getAttribute('data-url');
          
          if (onclick || dataHref) {
            const text = button.textContent?.trim() || '';
            links.push({
              href: dataHref || 'javascript:void(0)',
              text,
              element_type: button.tagName.toLowerCase(),
              selector: getSelector(button),
              position: getPosition(button),
              is_internal: dataHref ? dataHref.startsWith(currentOrigin) : false,
              is_button: true
            });
          }
        });

        return links;
      });
    } catch (error) {
      console.log('[Link Discovery] Error accessing page for link discovery:', (error as Error).message);
      return [];
    }
  }

  private async capturePageHtml() {
    const captureStartTime = Date.now();
    console.log(`[HTML Capture START] URL: ${this.currentUrl}, Time: ${new Date().toISOString()}`);
    
    if (!this.page || !this.recordingSession || !this.isRecording) {
      console.log('[HTML Capture SKIP] No page, recording session, or recording stopped');
      return;
    }

    // Skip HTML capture when in training mode
    if (this.isTrainingMode) {
      console.log(`[Training Mode] Skipping HTML capture`);
      return;
    }

    // Check if page is still connected before proceeding
    try {
      if (this.page.isClosed()) {
        console.log('[HTML Capture SKIP] Page is closed');
        return;
      }
    } catch (error) {
      console.log('[HTML Capture SKIP] Page connection error');
      return;
    }

    try {
      // Wait for page to be fully loaded using multiple strategies
      console.log('[HTML Capture] Waiting for page to be fully loaded...');
      
      try {
        // Wait for all network requests to finish
        await this.page.waitForLoadState('networkidle', { timeout: 3000 });
        console.log('[HTML Capture] Network idle achieved');
      } catch (e) {
        console.log('[HTML Capture] Network idle timeout, checking for DOM stability...');
        
        // If network idle fails, wait for DOM to stabilize
        await this.page.waitForFunction(() => {
          // Check if DOM content is stable by monitoring changes
          return new Promise((resolve) => {
            let checkCount = 0;
            let lastBodyContent = document.body.innerHTML;
            
            const checkStability = () => {
              const currentContent = document.body.innerHTML;
              if (currentContent === lastBodyContent) {
                checkCount++;
                if (checkCount >= 3) { // Stable for 3 checks (750ms)
                  resolve(true);
                  return;
                }
              } else {
                checkCount = 0;
                lastBodyContent = currentContent;
              }
              setTimeout(checkStability, 250);
            };
            
            checkStability();
          });
        }, { timeout: 5000 });
        console.log('[HTML Capture] DOM content stabilized');
      }
      
      // Also wait for any lazy loading images or scripts
      await this.page.waitForFunction(() => {
        // Check if there are any pending requests or loading indicators
        const loadingElements = document.querySelectorAll('[loading], .loading, .spinner');
        const pendingImages = Array.from(document.images).filter(img => !img.complete);
        
        return loadingElements.length === 0 && pendingImages.length === 0;
      }, { timeout: 2000 }).catch(() => {
        console.log('[HTML Capture] Some resources still loading, but continuing...');
      });
      
      // Always use the actual current URL
      const actualUrl = this.page.url();
      this.currentUrl = actualUrl;
      const sessionDir = path.join(process.cwd(), 'recordings', `session_${this.recordingSession.id}`);
      const pagesDir = path.join(sessionDir, 'pages');
      await fs.mkdir(pagesDir, { recursive: true });

      // Generate slug from current URL
      const slug = this.generateSlugFromUrl(this.currentUrl);
      const filename = `${slug}.html`;
      const filenameNoJs = `${slug}-no-js.html`;
      const cssFilename = `${slug}.css`;
      const filepath = path.join(pagesDir, filename);
      const filepathNoJs = path.join(pagesDir, filenameNoJs);
      const cssFilepath = path.join(pagesDir, cssFilename);

      // Check if files already exist
      try {
        await fs.access(filepath);
        console.log(`[HTML Capture SKIP] File already exists: ${filename}`);
        return;
      } catch (error) {
        // File doesn't exist, continue to save
      }

      // Check if page is still available before extracting CSS
      if (!this.page || this.page.isClosed() || !this.isRecording) {
        console.log('[HTML Capture SKIP] Page closed before CSS extraction');
        return;
      }

      // Extract CSS content
      const cssContent = await this.page.evaluate(() => {
        const stylesheets = Array.from(document.styleSheets);
        let cssText = '';
        
        for (const stylesheet of stylesheets) {
          try {
            const rules = stylesheet.cssRules || stylesheet.rules;
            if (rules) {
              const styleRules: string[] = [];
              for (let i = 0; i < rules.length; i++) {
                styleRules.push(rules[i].cssText);
              }
              cssText += styleRules.join('\n') + '\n';
            }
          } catch (e) {
            // Skip inaccessible stylesheets
          }
        }
        
        return cssText;
      });
      
      // Save CSS file
      if (cssContent) {
        await fs.writeFile(cssFilepath, cssContent);
        console.log(`[HTML Capture] Saved CSS: ${cssFilename}`);
      }

      // Discover all links on the page
      const discoveredLinks = await this.discoverLinks();
      console.log(`[HTML Capture] Discovered ${discoveredLinks.length} links on page`);

      // Check if page is still available before getting HTML
      if (!this.page || this.page.isClosed() || !this.isRecording) {
        console.log('[HTML Capture SKIP] Page closed before HTML extraction');
        return;
      }

      // Get clean HTML with CSS link
      const htmlWithCssLink = await this.page.evaluate((cssFilename) => {
        // Get the current HTML
        const html = document.documentElement.outerHTML;
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        // Remove existing stylesheet links and style tags
        const styleLinks = doc.querySelectorAll('link[rel="stylesheet"]');
        styleLinks.forEach(link => link.remove());
        const styleTags = doc.querySelectorAll('style');
        styleTags.forEach(style => style.remove());

        // Add CSS link reference
        const linkElement = doc.createElement('link');
        linkElement.rel = 'stylesheet';
        linkElement.type = 'text/css';
        linkElement.href = cssFilename;
        doc.head.appendChild(linkElement);

        return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
      }, cssFilename);
      
      // Save original HTML file with all JavaScript intact
      await fs.writeFile(filepath, htmlWithCssLink);
      console.log(`[HTML Capture] Saved original: ${filename}`);
      
      // Check if page is still available before creating no-js version
      if (!this.page || this.page.isClosed() || !this.isRecording) {
        console.log('[HTML Capture SKIP] Page closed before no-js HTML creation');
        return;
      }
      
      // Create no-js version using the same styled HTML
      const htmlNoJs = await this.page.evaluate(async () => {
        // Helper function to convert relative URLs to absolute
        function toAbsoluteUrl(url: string, baseUrl: string): string {
          try {
            return new URL(url, baseUrl).href;
          } catch {
            return url;
          }
        }

        // Get all stylesheets and inline them (same as original version)
        const stylesheets = Array.from(document.styleSheets);
        let cssText = '';

        // Extract CSS from each stylesheet
        for (const stylesheet of stylesheets) {
          try {
            // Skip cross-origin stylesheets
            if (stylesheet.href && !stylesheet.href.startsWith(window.location.origin)) {
              // Try to fetch cross-origin stylesheet
              try {
                const response = await fetch(stylesheet.href);
                if (response.ok) {
                  let css = await response.text();
                  // Convert relative URLs in CSS to absolute
                  css = css.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, url) => {
                    const absoluteUrl = toAbsoluteUrl(url, stylesheet.href!);
                    return `url('${absoluteUrl}')`;
                  });
                  cssText += `\n/* Stylesheet from ${stylesheet.href} */\n${css}\n`;
                }
              } catch (e) {
                console.warn('Could not fetch stylesheet:', stylesheet.href);
              }
              continue;
            }

            // For same-origin stylesheets, access rules directly
            const rules = stylesheet.cssRules || stylesheet.rules;
            if (rules) {
              const styleRules: string[] = [];
              for (let i = 0; i < rules.length; i++) {
                let ruleText = rules[i].cssText;
                // Convert relative URLs to absolute in CSS rules
                if (stylesheet.href) {
                  ruleText = ruleText.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, url) => {
                    const absoluteUrl = toAbsoluteUrl(url, stylesheet.href!);
                    return `url('${absoluteUrl}')`;
                  });
                }
                styleRules.push(ruleText);
              }
              cssText += `\n/* Stylesheet from ${stylesheet.href || 'inline'} */\n${styleRules.join('\n')}\n`;
            }
          } catch (e) {
            console.warn('Could not access stylesheet:', e);
          }
        }

        // Get the current HTML
        const html = document.documentElement.outerHTML;

        // Create a new HTML document with inlined styles
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        // Remove existing stylesheet links
        const styleLinks = doc.querySelectorAll('link[rel="stylesheet"]');
        styleLinks.forEach(link => link.remove());

        // Add combined CSS as a style element in head
        if (cssText) {
          const styleElement = doc.createElement('style');
          styleElement.textContent = cssText;
          doc.head.appendChild(styleElement);
        }

        // Convert relative URLs in img src, etc. to absolute
        const elementsWithUrls = doc.querySelectorAll('[src], [data-src]');
        elementsWithUrls.forEach(element => {
          ['src', 'data-src'].forEach(attr => {
            const value = element.getAttribute(attr);
            if (value && !value.startsWith('http') && !value.startsWith('data:')) {
              element.setAttribute(attr, toAbsoluteUrl(value, window.location.href));
            }
          });
        });
        
        // Remove all script tags
        const scripts = doc.querySelectorAll('script');
        scripts.forEach(script => script.remove());
        
        // Remove meta redirects
        const metaRedirects = doc.querySelectorAll('meta[http-equiv="refresh"]');
        metaRedirects.forEach(meta => meta.remove());
        
        // Remove event handlers
        const elementsWithEvents = doc.querySelectorAll('*');
        elementsWithEvents.forEach(element => {
          // Remove common event attributes
          ['onclick', 'onload', 'onmouseover', 'onmouseout', 'onchange', 'onsubmit', 'onfocus', 'onblur'].forEach(attr => {
            element.removeAttribute(attr);
          });
        });
        
        // Convert all links to show target but disable navigation
        const links = doc.querySelectorAll('a[href]');
        links.forEach(link => {
          const href = link.getAttribute('href');
          if (href && !href.startsWith('#')) {
            const isAbsolute = href.startsWith('http');
            const targetUrl = isAbsolute ? href : new URL(href, window.location.href).href;
            link.setAttribute('data-original-href', targetUrl);
            link.setAttribute('href', '#');
            link.setAttribute('title', 'Original link: ' + targetUrl);
            (link as HTMLElement).style.cssText = ((link as HTMLElement).style.cssText || '') + '; cursor: not-allowed !important; opacity: 0.7 !important;';
          }
        });
        
        // Disable forms
        const forms = doc.querySelectorAll('form');
        forms.forEach(form => {
          form.setAttribute('onsubmit', 'return false;');
          form.style.cssText = (form.style.cssText || '') + '; opacity: 0.7 !important;';
        });
        
        // Add notice at the top
        const notice = doc.createElement('div');
        notice.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; background: #ffeb3b; color: #333; padding: 8px; text-align: center; font-family: Arial, sans-serif; font-size: 14px; z-index: 9999; border-bottom: 2px solid #ffc107; box-shadow: 0 2px 4px rgba(0,0,0,0.1);';
        notice.innerHTML = '📄 Static HTML Version - JavaScript disabled, links and forms neutralized for safe viewing';
        
        // Add margin to body to account for notice
        if (doc.body) {
          doc.body.style.cssText = (doc.body.style.cssText || '') + '; margin-top: 40px !important;';
          doc.body.insertBefore(notice, doc.body.firstChild);
        }
        
        return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
      });
      
      // Save no-js HTML file
      await fs.writeFile(filepathNoJs, htmlNoJs);
      console.log(`[HTML Capture] Saved no-js version: ${filenameNoJs}`);
      
      const captureEndTime = Date.now();
      console.log(`[HTML Capture COMPLETE] Files: ${filename}, ${filenameNoJs}, ${cssFilename}, Duration: ${captureEndTime - captureStartTime}ms, URL: ${this.currentUrl}`);
    } catch (error) {
      console.error('[HTML Capture ERROR]', error);
    }
  }

  private startModalDetection() {
    if (!this.page || this.modalCheckInterval) return;

    console.log('[Modal Detection] Starting DOM mutation-based modal detection');

    // Set up DOM mutation observer for real-time detection
    this.setupMutationObserver();
    
    // Start Playwright-based component monitoring
    this.startPlaywrightComponentMonitoring();

    // Keep a minimal fallback polling for edge cases
    this.modalCheckInterval = setInterval(async () => {
      if (!this.isRecording || !this.page) {
        if (this.modalCheckInterval) {
          clearInterval(this.modalCheckInterval);
          this.modalCheckInterval = null;
        }
        return;
      }

      try {
        // Only do a quick check, the real detection is handled by mutations
        await this.detectAndCaptureModal();
      } catch (error) {
        console.error('[Modal Detection] Error in fallback detection:', error);
      }
    }, 2000); // Much less frequent polling
  }

  private async setupMutationObserver() {
    if (!this.page) return;

    try {
      // Inject a MutationObserver into the page
      await this.page.addInitScript(() => {
        // Set up mutation observer to watch for DOM changes
        const observer = new MutationObserver((mutations) => {
          console.log('[Browser] DOM mutations detected:', mutations.length);
          
          let hasNewElements = false;
          let hasStyleChanges = false;
          
          for (const mutation of mutations) {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
              // New elements were added
              for (const node of mutation.addedNodes) {
                if (node.nodeType === Node.ELEMENT_NODE) {
                  const element = node as Element;
                  console.log('[Browser] New element added:', element.tagName, element.className);
                  hasNewElements = true;
                  
                  // Immediately check if this new element or its children could be modals
                  setTimeout(() => {
                    (window as any).checkForNewModals && (window as any).checkForNewModals(element);
                  }, 100); // Small delay to allow for styling to be applied
                }
              }
            }
            
            if (mutation.type === 'attributes') {
              const element = mutation.target as Element;
              if (mutation.attributeName === 'style' || mutation.attributeName === 'class') {
                console.log('[Browser] Style/class change on:', element.tagName, element.className);
                hasStyleChanges = true;
                
                // Check if this element became visible and modal-like
                setTimeout(() => {
                  (window as any).checkForNewModals && (window as any).checkForNewModals(element);
                }, 50);
              }
            }
          }
          
          // Signal that we should check for modals
          if (hasNewElements || hasStyleChanges) {
            (window as any).modalDetectionTriggered = true;
          }
        });
        
        // Start observing
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['style', 'class', 'data-state', 'aria-hidden']
        });
        
        console.log('[Browser] MutationObserver set up for modal detection');
        
        // Function to analyze a specific element and its children for modal characteristics
        (window as any).checkForNewModals = function(rootElement: Element) {
          console.log('[Browser] Checking new/changed element for modal characteristics:', rootElement.tagName);
          
          const elementsToCheck = [rootElement];
          // Also check children
          if (rootElement.querySelectorAll) {
            elementsToCheck.push(...Array.from(rootElement.querySelectorAll('*')));
          }
          
          for (const element of elementsToCheck) {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            
            // Quick modal characteristics check
            if (rect.width > 200 && rect.height > 150 && 
                style.display !== 'none' && 
                style.visibility !== 'hidden' &&
                style.opacity !== '0' &&
                (style.position === 'fixed' || style.position === 'absolute')) {
              
              // Check for modal-like content
              const text = element.textContent?.toLowerCase() || '';
              const className = element.className?.toLowerCase() || '';
              
              const hasModalKeywords = text.includes('login') || text.includes('sign in') || 
                                     text.includes('password') || text.includes('email') ||
                                     className.includes('modal') || className.includes('dialog') ||
                                     className.includes('popup') || className.includes('overlay');
              
              const isNewModal = !element.hasAttribute('data-modal-detected');
              
              if (hasModalKeywords && isNewModal) {
                console.log('[Browser] New modal detected via mutation!', element.tagName, element.className);
                element.setAttribute('data-modal-detected', 'true');
                (window as any).modalDetectionTriggered = true;
                break;
              }
            }
          }
        };
      });

      // Set up polling to check the mutation flag
      this.mutationCheckInterval = setInterval(async () => {
        if (!this.isRecording || !this.page) {
          if (this.mutationCheckInterval) {
            clearInterval(this.mutationCheckInterval);
            this.mutationCheckInterval = null;
          }
          return;
        }

        try {
          const shouldCheck = await this.page.evaluate(() => {
            const flag = (window as any).modalDetectionTriggered;
            (window as any).modalDetectionTriggered = false; // Reset flag
            return flag;
          });

          if (shouldCheck) {
            console.log('[Modal Detection] DOM mutations triggered modal check');
            await this.detectAndCaptureModal();
          }
        } catch (error) {
          // Ignore errors from closed pages
        }
      }, 200); // Check mutation flag every 200ms

      console.log('[Modal Detection] MutationObserver-based detection set up');
    } catch (error) {
      console.error('[Modal Detection] Error setting up mutation observer:', error);
    }
  }

  private async detectAndCaptureModal() {
    if (!this.page || !this.isRecording || !this.recordingSession) return;

    try {
      // Check if page is still connected
      if (this.page.isClosed()) return;

      // Intelligent modal detection without predefined selectors
      const modalDetected = await this.page.evaluate(() => {
        console.log('[Browser] Starting intelligent modal detection...');
        
        // Store the current DOM state to compare later
        if (!(window as any).modalDetectionState) {
          (window as any).modalDetectionState = {
            lastBodySize: document.body.children.length,
            lastElements: new Set(Array.from(document.querySelectorAll('*')).map(el => el.tagName + '|' + el.className))
          };
        }
        
        // Function to analyze if an element looks like a modal
        function analyzeElementAsModal(element: Element) {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          
          // Basic visibility checks
          if (rect.width < 50 || rect.height < 50 ||
              style.display === 'none' || 
              style.visibility === 'hidden' ||
              style.opacity === '0') {
            return null;
          }
          
          // Modal characteristics scoring
          let modalScore = 0;
          let reasons = [];
          
          // 1. Position characteristics
          if (style.position === 'fixed') {
            modalScore += 30;
            reasons.push('fixed position');
          }
          if (style.position === 'absolute') {
            modalScore += 20;
            reasons.push('absolute position');
          }
          
          // 2. Z-index (higher = more likely modal)
          const zIndex = parseInt(style.zIndex) || 0;
          if (zIndex > 1000) {
            modalScore += 25;
            reasons.push('high z-index');
          } else if (zIndex > 100) {
            modalScore += 15;
            reasons.push('elevated z-index');
          }
          
          // 3. Centering characteristics
          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;
          const viewportCenterX = window.innerWidth / 2;
          const viewportCenterY = window.innerHeight / 2;
          
          const horizontalDistance = Math.abs(centerX - viewportCenterX);
          const verticalDistance = Math.abs(centerY - viewportCenterY);
          
          if (horizontalDistance < 100) {
            modalScore += 20;
            reasons.push('horizontally centered');
          }
          if (verticalDistance < 150) {
            modalScore += 20;
            reasons.push('vertically centered');
          }
          
          // 4. Size characteristics (reasonable modal size)
          if (rect.width > 300 && rect.width < window.innerWidth * 0.8 &&
              rect.height > 200 && rect.height < window.innerHeight * 0.8) {
            modalScore += 25;
            reasons.push('modal-like dimensions');
          }
          
          // 5. Content analysis
          const text = element.textContent || '';
          const textLower = text.toLowerCase();
          
          // Modal-like content indicators
          const modalKeywords = ['login', 'log in', 'sign in', 'register', 'sign up', 'password', 'email', 'close', 'cancel', 'ok', 'submit'];
          const foundKeywords = modalKeywords.filter(keyword => textLower.includes(keyword));
          if (foundKeywords.length > 0) {
            modalScore += foundKeywords.length * 5;
            reasons.push(`contains modal keywords: ${foundKeywords.join(', ')}`);
          }
          
          // Has form elements
          if (element.querySelector('input, button, form')) {
            modalScore += 15;
            reasons.push('contains form elements');
          }
          
          // 6. CSS class name analysis
          const className = element.className || '';
          const classLower = className.toLowerCase();
          
          const modalClassKeywords = ['modal', 'dialog', 'popup', 'overlay', 'backdrop', 'lightbox'];
          const foundClassKeywords = modalClassKeywords.filter(keyword => classLower.includes(keyword));
          if (foundClassKeywords.length > 0) {
            modalScore += foundClassKeywords.length * 10;
            reasons.push(`modal-like class names: ${foundClassKeywords.join(', ')}`);
          }
          
          // 7. Background characteristics (backdrop detection)
          const hasBackdrop = style.backgroundColor !== 'rgba(0, 0, 0, 0)' && 
                             style.backgroundColor !== 'transparent' &&
                             (rect.width > window.innerWidth * 0.8 || rect.height > window.innerHeight * 0.8);
          if (hasBackdrop) {
            modalScore += 15;
            reasons.push('has backdrop characteristics');
          }
          
          // 8. Recently appeared elements get bonus
          const elementSignature = element.tagName + '|' + element.className;
          if (!(window as any).modalDetectionState.lastElements.has(elementSignature)) {
            modalScore += 20;
            reasons.push('recently appeared');
          }
          
          console.log(`[Browser] Element analysis: ${element.tagName}.${element.className?.split(' ')[0] || 'no-class'} - Score: ${modalScore}, Reasons: ${reasons.join(', ')}`);
          
          return modalScore >= 50 ? {
            element,
            score: modalScore,
            reasons,
            rect,
            style
          } : null;
        }

        // Analyze ALL elements on the page intelligently
        const allElements = Array.from(document.querySelectorAll('*'));
        console.log(`[Browser] Analyzing ${allElements.length} elements for modal characteristics...`);
        
        const modalCandidates = [];
        
        for (const element of allElements) {
          const analysis = analyzeElementAsModal(element);
          if (analysis) {
            modalCandidates.push(analysis);
          }
        }
        
        // Sort by score (highest first)
        modalCandidates.sort((a, b) => b.score - a.score);
        
        console.log(`[Browser] Found ${modalCandidates.length} modal candidates`);
        
        if (modalCandidates.length > 0) {
          const bestCandidate = modalCandidates[0];
          const element = bestCandidate.element;
          
          console.log(`[Browser] Best modal candidate: Score ${bestCandidate.score}, Reasons: ${bestCandidate.reasons.join(', ')}`);
          
          // Generate a selector for this element
          let selector = element.tagName.toLowerCase();
          if (element.id) {
            selector = `#${element.id}`;
          } else if (element.className) {
            const mainClass = element.className.split(' ')[0];
            if (mainClass) {
              selector = `.${mainClass}`;
            }
          }
          
          // Update our tracking state
          (window as any).modalDetectionState.lastElements = new Set(Array.from(document.querySelectorAll('*')).map(el => el.tagName + '|' + el.className));
          
          return {
            found: true,
            selector: selector,
            dimensions: {
              width: bestCandidate.rect.width,
              height: bestCandidate.rect.height,
              top: bestCandidate.rect.top,
              left: bestCandidate.rect.left
            },
            content: element.textContent?.trim().substring(0, 200) || '',
            uniqueId: element.id || element.className?.split(' ')[0] || 'detected-modal',
            score: bestCandidate.score,
            reasons: bestCandidate.reasons
          };
        }
        
        console.log(`[Browser] No modal candidates found with sufficient score`);
        return { found: false };
      });

      if (modalDetected && modalDetected.found) {
        // Check if this is the same modal we're already tracking
        if (this.activeModal && this.activeModal.modal_selector === modalDetected.selector) {
          // Check for changes in the modal content
          if (this.lastModalContent !== modalDetected.content && this.lastAction) {
            console.log(`[Modal Change Detected] Content changed in active modal`);
            await this.captureModalStateChange(modalDetected);
          }
        } else {
          // Check if we've already captured this modal
          const modalId = `${this.currentUrl}-${modalDetected.uniqueId}`;
          const contentPreview = modalDetected.content?.substring(0, 50) || '';
          const alreadyCaptured = this.recordingSession.modals?.some(
            m => m.modal_selector === modalDetected.selector && 
                 m.modal_content?.substring(0, 50) === contentPreview
          );

          if (!alreadyCaptured) {
          console.log(`[Modal Detected] Selector: ${modalDetected.selector}`);
          console.log(`[Modal Detected] Dimensions: ${modalDetected.dimensions?.width}x${modalDetected.dimensions?.height} at (${modalDetected.dimensions?.left}, ${modalDetected.dimensions?.top})`);
          
          // Wait for modal to be fully loaded
          try {
            // Wait for any animations to complete by checking if the modal position/size is stable
            await this.page.waitForFunction(
              (selector: string) => {
                const element = document.querySelector(selector);
                if (!element) return false;
                
                return new Promise((resolve) => {
                  let lastRect = element.getBoundingClientRect();
                  let lastContent = element.innerHTML;
                  let checks = 0;
                  
                  const checkStability = () => {
                    const currentRect = element.getBoundingClientRect();
                    const currentContent = element.innerHTML;
                    
                    // Also check for loading indicators within the modal
                    const hasLoadingIndicators = element.querySelector('.loading, .spinner, [class*="loading"], [class*="spinner"], [class*="skeleton"]');
                    const hasDisabledButtons = element.querySelector('button[disabled], input[disabled], [aria-busy="true"]');
                    
                    // Check if position, size, and content are stable, and no loading indicators
                    if (currentRect.width === lastRect.width &&
                        currentRect.height === lastRect.height &&
                        currentRect.top === lastRect.top &&
                        currentRect.left === lastRect.left &&
                        currentContent === lastContent &&
                        !hasLoadingIndicators &&
                        !hasDisabledButtons) {
                      checks++;
                      if (checks >= 3) { // Stable for 3 checks (300ms)
                        resolve(true);
                        return;
                      }
                    } else {
                      checks = 0;
                      lastRect = currentRect;
                      lastContent = currentContent;
                    }
                    
                    setTimeout(checkStability, 100);
                  };
                  
                  checkStability();
                });
              },
              modalDetected.selector || 'body',
              { timeout: 2000 }
            );
            console.log(`[Modal Detected] Modal is stable and fully rendered`);
          } catch (e) {
            console.log(`[Modal Detected] Stability check timed out, proceeding anyway`);
          }
          
          // Take screenshot of the modal
          const sessionDir = path.join(process.cwd(), 'recordings', `session_${this.recordingSession.id}`);
          const screenshotsDir = path.join(sessionDir, 'screenshots');
          await fs.mkdir(screenshotsDir, { recursive: true });

          this.modalScreenshotIndex++;
          // Generate slug from current URL for modal screenshot
          const slug = this.generateSlugFromUrl(this.currentUrl);
          
          // Count existing modal screenshots for this slug
          const existingModalShots = this.recordingSession.screenshots.filter(s => 
            s.startsWith(`${slug}_modal_`)
          ).length;
          const modalIndex = (existingModalShots + 1).toString().padStart(3, '0');
          
          const filename = `${slug}_modal_${modalIndex}.png`;
          const filepath = path.join(screenshotsDir, filename);

          try {
            // Make sure page is still available
            if (!this.page || this.page.isClosed()) {
              console.error(`[Modal Screenshot] Page closed, cannot capture`);
              return;
            }

            // Try to capture just the modal element
            const modalElement = await this.page.$(modalDetected.selector || 'body');
            if (modalElement) {
              // Take screenshot of just the modal element
              await modalElement.screenshot({
                path: filepath
              });
              console.log(`[Modal Screenshot] Saved modal element: ${filename}`);
            } else {
              // Fallback to viewport screenshot if element not found
              await this.page.screenshot({
                path: filepath,
                fullPage: false // Just viewport
              });
              console.log(`[Modal Screenshot] Saved viewport: ${filename}`);
            }

            console.log(`[Modal Screenshot] Saved to: ${filepath}`);
          } catch (screenshotError) {
            console.error(`[Modal Screenshot] Failed to capture: ${(screenshotError as Error).message}`);
            console.error(`[Modal Screenshot] Error details:`, screenshotError);
          }

          // Create modal record
          const modal: DetectedModal = {
            id: uuidv4(),
            timestamp: new Date().toISOString(),
            triggered_by: {
              action_type: this.lastAction?.type || 'unknown',
              action_description: this.lastAction?.actions?.[0]?.action_description || 'Modal appeared',
              element_selector: this.lastAction?.element_selector,
              element_text: this.lastAction?.element_text
            },
            modal_selector: modalDetected.selector,
            modal_content: modalDetected.content,
            screenshot: filename,
            dimensions: modalDetected.dimensions,
            state_changes: []
          };

          // Add to recording session
          if (!this.recordingSession.modals) {
            this.recordingSession.modals = [];
          }
          this.recordingSession.modals.push(modal);

          // Also add to screenshots list for reference
          this.recordingSession.screenshots.push(filename);

          // Track this as the active modal
          this.activeModal = modal;
          this.lastModalContent = modalDetected.content || null;

          console.log(`[Modal Captured] Triggered by: ${modal.triggered_by.action_description}`);
          }
        }
      } else if (this.activeModal) {
        // Modal was closed
        console.log(`[Modal Closed] Modal ${this.activeModal.modal_selector} is no longer visible`);
        this.activeModal = null;
        this.lastModalContent = null;
      }
    } catch (error) {
      // Silently ignore modal detection errors
    }
  }

  private async captureModalStateChange(modalData: any) {
    if (!this.activeModal || !this.page || !this.recordingSession) return;

    try {
      const sessionDir = path.join(process.cwd(), 'recordings', `session_${this.recordingSession.id}`);
      const screenshotsDir = path.join(sessionDir, 'screenshots');
      
      this.modalScreenshotIndex++;
      // Generate slug from current URL for modal change screenshot
      const slug = this.generateSlugFromUrl(this.currentUrl);
      
      // Count existing modal change screenshots for this slug
      const existingModalChangeShots = this.recordingSession.screenshots.filter(s => 
        s.startsWith(`${slug}_modal_`) && s.includes('_change')
      ).length;
      const changeIndex = (existingModalChangeShots + 1).toString().padStart(3, '0');
      
      const filename = `${slug}_modal_change_${changeIndex}.png`;
      const filepath = path.join(screenshotsDir, filename);

      // Capture screenshot of the modal with changes
      const modalElement = await this.page.$(modalData.selector);
      if (modalElement) {
        await modalElement.screenshot({
          path: filepath
        });
        console.log(`[Modal Change Screenshot] Saved: ${filename}`);
      }

      // Create state change record
      const stateChange: ModalStateChange = {
        timestamp: new Date().toISOString(),
        triggered_by: {
          action_type: this.lastAction?.type || 'unknown',
          action_description: this.lastAction?.actions?.[0]?.action_description || 'Modal content changed',
          element_selector: this.lastAction?.element_selector,
          element_text: this.lastAction?.element_text
        },
        change_description: `Content changed in modal`,
        screenshot: filename,
        content_diff: this.getContentDiff(this.lastModalContent || '', modalData.content || '')
      };

      // Add to active modal's state changes
      if (!this.activeModal.state_changes) {
        this.activeModal.state_changes = [];
      }
      this.activeModal.state_changes.push(stateChange);

      // Update last content
      this.lastModalContent = modalData.content;

      // Also add to screenshots list
      this.recordingSession.screenshots.push(filename);

      console.log(`[Modal State Change] Captured change triggered by: ${stateChange.triggered_by.action_description}`);
    } catch (error) {
      console.error(`[Modal State Change] Error capturing state change:`, error);
    }
  }

  private getContentDiff(oldContent: string, newContent: string): string {
    // Simple diff - just show what changed
    if (oldContent.length === 0) return `New content: ${newContent.substring(0, 100)}...`;
    if (newContent.length === 0) return `Content removed`;
    
    // Find first difference
    let i = 0;
    while (i < Math.min(oldContent.length, newContent.length) && oldContent[i] === newContent[i]) {
      i++;
    }
    
    if (i === oldContent.length && i === newContent.length) {
      return 'No change detected';
    }
    
    return `Changed from position ${i}: "${oldContent.substring(i, i + 50)}..." to "${newContent.substring(i, i + 50)}..."`;
  }

  // Inject persistent debug overlay that survives page navigation
  private async injectPersistentDebugOverlay() {
    if (!this.page) return;

    try {
      // Expose function for training mode exit callback
      await this.page.exposeFunction('notifyTrainingModeExited', () => {
        console.log('[Modal Training] Browser notified training mode exit - disabling training mode');
        this.disableTrainingMode();
      });
      
      // Expose function for deleting trained components
      await this.page.exposeFunction('deleteTrainedComponent', async (componentId: string) => {
        console.log('[Modal Training] Delete request for component:', componentId);
        const success = await this.deleteTrainedComponent(componentId);
        return success;
      });
      
      // Set up persistent script injection for all pages
      await this.page.addInitScript(() => {
        // Global training mode state
        (window as any).__crawlerTrainingMode = (window as any).__crawlerTrainingMode || false;
        
        // Function to create debug overlay - make it globally accessible
        (window as any).createDebugOverlay = function createDebugOverlay() {
          // Check if overlay already exists and has training mode indicator
          const existingOverlay = document.getElementById('crawler-debug-overlay');
          const existingIndicator = document.getElementById('training-mode-indicator');
          // Get training mode state from global or existing indicator
          const isTrainingMode = (window as any).__crawlerTrainingMode || false;
          let currentTrainingModeText = isTrainingMode ? '📚 TRAINING MODE' : '🎥 RECORDING MODE';
          let currentTrainingModeBackground = isTrainingMode ? '#e74c3c' : '#27ae60';
          let currentTrainingModeBorder = isTrainingMode ? '#c0392b' : '#229954';
          
          if (existingIndicator && existingIndicator.textContent) {
            // Preserve current state from existing indicator if available
            currentTrainingModeText = existingIndicator.textContent;
            currentTrainingModeBackground = existingIndicator.style.background || currentTrainingModeBackground;
            currentTrainingModeBorder = existingIndicator.style.borderColor || currentTrainingModeBorder;
          }
          
          // Remove existing overlay if it exists
          if (existingOverlay) {
            existingOverlay.remove();
          }

          // Create overlay container
          const overlay = document.createElement('div');
          overlay.id = 'crawler-debug-overlay';
          overlay.style.cssText = `
            position: fixed !important;
            top: 10px !important;
            right: 10px !important;
            z-index: 2147483647 !important;
            background: rgba(0, 0, 0, 0.95) !important;
            color: white !important;
            padding: 6px !important;
            border-radius: 4px !important;
            font-family: monospace !important;
            font-size: 10px !important;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5) !important;
            border: 2px solid #ff6b35 !important;
            width: auto !important;
            white-space: nowrap !important;
          `;

          // Create title
          const title = document.createElement('div');
          title.textContent = '🔍 Crawler Debug';
          title.style.cssText = `
            font-weight: bold !important;
            margin-bottom: 8px !important;
            color: #ffa500 !important;
            cursor: move !important;
          `;
          overlay.appendChild(title);

          // Create content container
          const content = document.createElement('div');
          content.id = 'debug-content';

          // Create training mode status indicator - ADD IT FIRST
          console.log('[Debug Overlay] Creating training mode indicator:', {
            text: currentTrainingModeText,
            background: currentTrainingModeBackground,
            border: currentTrainingModeBorder
          });
          
          const trainingModeIndicator = document.createElement('div');
          trainingModeIndicator.id = 'training-mode-indicator';
          trainingModeIndicator.style.cssText = 
            'display: block !important;' +
            'width: 100% !important;' +
            'padding: 6px 10px !important;' +
            'margin: 0 0 8px 0 !important;' +
            'background: ' + currentTrainingModeBackground + ' !important;' +
            'color: white !important;' +
            'border: none !important;' +
            'border-radius: 4px !important;' +
            'font-size: 11px !important;' +
            'font-family: monospace !important;' +
            'font-weight: bold !important;' +
            'text-align: center !important;' +
            'white-space: nowrap !important;' +
            'border: 2px solid ' + currentTrainingModeBorder + ' !important;' +
            'box-sizing: border-box !important;';
          trainingModeIndicator.textContent = currentTrainingModeText;
          content.appendChild(trainingModeIndicator);
          
          console.log('[Debug Overlay] Training mode indicator added to content');

          // Create debug modal button
          const debugButton = document.createElement('button');
          debugButton.textContent = 'Debug Modals';
          debugButton.style.cssText = `
            display: block !important;
            width: auto !important;
            padding: 3px 6px !important;
            margin: 0 0 2px 0 !important;
            background: #ff6b35 !important;
            color: white !important;
            border: none !important;
            border-radius: 2px !important;
            cursor: pointer !important;
            font-size: 9px !important;
            font-family: monospace !important;
            white-space: nowrap !important;
          `;
          debugButton.onclick = () => {
            console.log('[Debug Overlay] Manual modal detection triggered');
          };
          content.appendChild(debugButton);

          // Create capture button
          const captureButton = document.createElement('button');
          captureButton.textContent = 'Capture Full Screen';
          captureButton.style.cssText = `
            display: block !important;
            width: auto !important;
            padding: 3px 6px !important;
            margin: 0 0 2px 0 !important;
            background: #4a90e2 !important;
            color: white !important;
            border: none !important;
            border-radius: 2px !important;
            cursor: pointer !important;
            font-size: 9px !important;
            font-family: monospace !important;
            white-space: nowrap !important;
          `;
          captureButton.onclick = () => {
            console.log('[Debug Overlay] Manual screenshot capture triggered');
          };
          content.appendChild(captureButton);

          // Create capture area button
          const captureAreaButton = document.createElement('button');
          captureAreaButton.textContent = 'Capture Selected Area';
          captureAreaButton.style.cssText = `
            display: block !important;
            width: auto !important;
            padding: 3px 6px !important;
            margin: 0 0 2px 0 !important;
            background: #28a745 !important;
            color: white !important;
            border: none !important;
            border-radius: 2px !important;
            cursor: pointer !important;
            font-size: 9px !important;
            font-family: monospace !important;
            white-space: nowrap !important;
          `;
          captureAreaButton.onclick = () => {
            (window as any).startAreaSelection();
          };
          content.appendChild(captureAreaButton);

          // Create modal training button
          const trainButton = document.createElement('button');
          trainButton.textContent = 'Train Modal Detection';
          trainButton.style.cssText = `
            display: block !important;
            width: auto !important;
            padding: 3px 6px !important;
            margin: 0 0 2px 0 !important;
            background: #8e44ad !important;
            color: white !important;
            border: none !important;
            border-radius: 2px !important;
            cursor: pointer !important;
            font-size: 9px !important;
            font-family: monospace !important;
            white-space: nowrap !important;
          `;
          trainButton.onclick = function() {
            (window as any).startModalTraining();
          };
          content.appendChild(trainButton);

          // Create show trained data button (labeled as Discovery Mode)
          const showTrainedButton = document.createElement('button');
          showTrainedButton.textContent = 'Show Trained Data';
          showTrainedButton.style.cssText = `
            display: block !important;
            width: auto !important;
            padding: 3px 6px !important;
            margin: 0 0 2px 0 !important;
            background: #f39c12 !important;
            color: white !important;
            border: none !important;
            border-radius: 2px !important;
            cursor: pointer !important;
            font-size: 9px !important;
            font-family: monospace !important;
            white-space: nowrap !important;
          `;
          showTrainedButton.onclick = () => {
            (window as any).showTrainedData();
          };
          content.appendChild(showTrainedButton);



          overlay.appendChild(content);

          // Create toggle button
          const toggleButton = document.createElement('button');
          toggleButton.textContent = 'Hide';
          toggleButton.style.cssText = `
            display: block !important;
            width: auto !important;
            padding: 2px 4px !important;
            margin: 2px 0 0 0 !important;
            background: #666 !important;
            color: white !important;
            border: none !important;
            border-radius: 2px !important;
            cursor: pointer !important;
            font-size: 8px !important;
            font-family: monospace !important;
            white-space: nowrap !important;
          `;
          
          let isMinimized = false;
          toggleButton.onclick = () => {
            isMinimized = !isMinimized;
            content.style.display = isMinimized ? 'none' : 'block';
            toggleButton.textContent = isMinimized ? 'Show' : 'Hide';
          };
          
          overlay.appendChild(toggleButton);

          // Add to page
          document.body.appendChild(overlay);

          // Make it draggable
          let isDragging = false;
          let dragOffset = { x: 0, y: 0 };
          
          title.onmousedown = (e) => {
            isDragging = true;
            dragOffset.x = e.clientX - overlay.offsetLeft;
            dragOffset.y = e.clientY - overlay.offsetTop;
            e.preventDefault();
          };
          
          document.onmousemove = (e) => {
            if (isDragging) {
              overlay.style.left = (e.clientX - dragOffset.x) + 'px';
              overlay.style.top = (e.clientY - dragOffset.y) + 'px';
              overlay.style.right = 'auto';
            }
          };
          
          document.onmouseup = () => {
            isDragging = false;
          };

          console.log('[Debug Overlay] Persistent overlay injected');
        };

        // Area selection function
        (window as any).startAreaSelection = () => {
          // [Same area selection code as before but cleaned up]
          const existingSelection = document.getElementById('crawler-selection-overlay');
          if (existingSelection) existingSelection.remove();

          const selectionOverlay = document.createElement('div');
          selectionOverlay.id = 'crawler-selection-overlay';
          selectionOverlay.style.cssText = `
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            width: 100vw !important;
            height: 100vh !important;
            background: rgba(0, 0, 0, 0.3) !important;
            z-index: 2147483646 !important;
            cursor: crosshair !important;
          `;

          const selectionBox = document.createElement('div');
          selectionBox.style.cssText = `
            position: absolute !important;
            border: 2px solid #ff6b35 !important;
            background: rgba(255, 107, 53, 0.1) !important;
            display: none !important;
            pointer-events: none !important;
          `;
          selectionOverlay.appendChild(selectionBox);

          let isSelecting = false;
          let startX = 0, startY = 0;

          const startSelection = (e: MouseEvent) => {
            isSelecting = true;
            startX = e.clientX;
            startY = e.clientY;
            selectionBox.style.left = startX + 'px';
            selectionBox.style.top = startY + 'px';
            selectionBox.style.width = '0px';
            selectionBox.style.height = '0px';
            selectionBox.style.display = 'block';
          };

          const updateSelection = (e: MouseEvent) => {
            if (!isSelecting) return;
            const currentX = e.clientX;
            const currentY = e.clientY;
            const left = Math.min(startX, currentX);
            const top = Math.min(startY, currentY);
            const width = Math.abs(currentX - startX);
            const height = Math.abs(currentY - startY);
            selectionBox.style.left = left + 'px';
            selectionBox.style.top = top + 'px';
            selectionBox.style.width = width + 'px';
            selectionBox.style.height = height + 'px';
          };

          const finishSelection = (e: MouseEvent) => {
            if (!isSelecting) return;
            const currentX = e.clientX;
            const currentY = e.clientY;
            const left = Math.min(startX, currentX);
            const top = Math.min(startY, currentY);
            const width = Math.abs(currentX - startX);
            const height = Math.abs(currentY - startY);
            
            if (width > 10 && height > 10) {
              // Adjust coordinates for browser zoom level
              const zoomLevel = window.devicePixelRatio / (window.visualViewport?.scale || 1);
              const adjustedLeft = Math.round(left * zoomLevel);
              const adjustedTop = Math.round(top * zoomLevel);
              const adjustedWidth = Math.round(width * zoomLevel);
              const adjustedHeight = Math.round(height * zoomLevel);
              
              console.log('[Debug Overlay] Area capture triggered: ' + adjustedLeft + ',' + adjustedTop + ' ' + adjustedWidth + 'x' + adjustedHeight);
            }
            selectionOverlay.remove();
          };

          selectionOverlay.addEventListener('mousedown', startSelection);
          selectionOverlay.addEventListener('mousemove', updateSelection);
          selectionOverlay.addEventListener('mouseup', finishSelection);
          
          const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
              selectionOverlay.remove();
              document.removeEventListener('keydown', handleKeyDown);
            }
          };
          document.addEventListener('keydown', handleKeyDown);
          
          document.body.appendChild(selectionOverlay);
        };

        // Modal training function with visual element highlighting
        (window as any).startModalTraining = () => {
          console.log('[Modal Training] Starting element selection mode');
          
          // Remove any existing training overlay
          const existingTraining = document.getElementById('modal-training-overlay');
          if (existingTraining) existingTraining.remove();

          // Create training overlay
          const trainingOverlay = document.createElement('div');
          trainingOverlay.id = 'modal-training-overlay';
          trainingOverlay.style.cssText = `
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            width: 100vw !important;
            height: 100vh !important;
            pointer-events: none !important;
            z-index: 2147483645 !important;
          `;

          // Create instruction panel
          const instructionPanel = document.createElement('div');
          instructionPanel.id = 'training-instruction-panel';
          instructionPanel.style.cssText = `
            position: fixed !important;
            top: 20px !important;
            left: 50% !important;
            transform: translateX(-50%) !important;
            background: rgba(0, 0, 0, 0.9) !important;
            color: white !important;
            padding: 15px 25px !important;
            border-radius: 8px !important;
            font-family: monospace !important;
            font-size: 14px !important;
            text-align: center !important;
            pointer-events: auto !important;
            z-index: 2147483647 !important;
            max-width: 500px !important;
          `;
          instructionPanel.innerHTML = `
            <div style="margin-bottom: 10px; font-weight: bold;">🎯 Modal Training Mode</div>
            <div style="font-size: 12px; opacity: 0.9; line-height: 1.4;">
              Hover over elements to see colored borders.<br>
              Click on modal elements to train the detection system.<br>
              <span style="color: #ff6b35;">Orange</span> = High modal potential | 
              <span style="color: #f39c12;">Yellow</span> = Medium | 
              <span style="color: #3498db;">Blue</span> = Low
            </div>
            <button id="exit-training" style="
              margin-top: 10px; padding: 5px 15px; background: #e74c3c; 
              color: white; border: none; border-radius: 4px; cursor: pointer;
              pointer-events: auto !important; z-index: 2147483649 !important;
            ">Exit Training</button>
          `;
          document.body.appendChild(instructionPanel);

          // Add element highlighting on mouseover
          let currentHighlight: HTMLElement | null = null;
          const highlightElement = (element: Element) => {
            if (currentHighlight) {
              currentHighlight.remove();
            }

            const rect = element.getBoundingClientRect();
            const highlight = document.createElement('div');
            
            // Calculate modal score for color coding
            const modalScore = calculateModalScore(element);
            let borderColor = '#3498db'; // Blue for low score
            if (modalScore > 70) borderColor = '#ff6b35'; // Orange for high score
            else if (modalScore > 40) borderColor = '#f39c12'; // Yellow for medium score

            highlight.style.cssText = `
              position: fixed !important;
              top: ${rect.top}px !important;
              left: ${rect.left}px !important;
              width: ${rect.width}px !important;
              height: ${rect.height}px !important;
              border: 3px solid ${borderColor} !important;
              background: ${borderColor}22 !important;
              pointer-events: none !important;
              z-index: 2147483646 !important;
              border-radius: 4px !important;
            `;
            
            trainingOverlay.appendChild(highlight);
            currentHighlight = highlight;

            // Show element info
            const info = document.createElement('div');
            info.style.cssText = `
              position: fixed !important;
              top: ${rect.bottom + 5}px !important;
              left: ${rect.left}px !important;
              background: rgba(0, 0, 0, 0.8) !important;
              color: white !important;
              padding: 5px 10px !important;
              border-radius: 4px !important;
              font-family: monospace !important;
              font-size: 11px !important;
              z-index: 2147483647 !important;
              max-width: 300px !important;
            `;
            
            const tagName = element.tagName.toLowerCase();
            const className = element.className ? element.className.split(' ')[0] : 'no-class';
            const id = element.id || 'no-id';
            
            info.innerHTML = `
              <div><strong>${tagName}</strong> .${className} #${id}</div>
              <div>Modal Score: ${modalScore}</div>
            `;
            
            trainingOverlay.appendChild(info);
            
            setTimeout(() => {
              if (info.parentNode) info.remove();
            }, 2000);
          };

          // Calculate modal score for an element
          const calculateModalScore = (element: Element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            let score = 0;

            // Position scoring
            if (style.position === 'fixed') score += 30;
            else if (style.position === 'absolute') score += 20;

            // Z-index scoring
            const zIndex = parseInt(style.zIndex) || 0;
            if (zIndex > 1000) score += 25;
            else if (zIndex > 100) score += 15;

            // Size scoring
            if (rect.width > 300 && rect.width < window.innerWidth * 0.8 &&
                rect.height > 200 && rect.height < window.innerHeight * 0.8) {
              score += 25;
            }

            // Class name scoring
            const className = element.className.toLowerCase();
            if (/modal|dialog|popup|overlay/.test(className)) score += 20;
            if (/styled__modal/i.test(className)) score += 30;

            // Content scoring
            const text = element.textContent?.toLowerCase() || '';
            if (/edit|create|add|delete|confirm|save|cancel/.test(text)) score += 15;

            return score;
          };

          // Define event handlers with proper references
          const handleMouseOver = (e: Event) => {
            const target = e.target as Element;
            if (target && target !== trainingOverlay && target !== instructionPanel && 
                !instructionPanel.contains(target)) {
              highlightElement(target);
            }
          };

          const handleTrainingClick = (e: Event) => {
            const target = e.target as Element;
            
            // Explicitly exclude ALL training UI elements including dialogs
            if (target.id === 'exit-training' || 
                target.closest('#exit-training') ||
                target.closest('#training-instruction-panel') ||
                target.closest('[id^="training-dialog-"]') || // Any training dialog
                instructionPanel.contains(target) ||
                trainingOverlay.contains(target)) {
              console.log('[Modal Training] Click ignored - training UI element');
              return; // Don't prevent default, let the button work normally
            }
            
            // Don't process clicks on training overlay elements or dialogs
            if (target && target !== trainingOverlay && target !== instructionPanel && 
                !instructionPanel.contains(target) && !trainingOverlay.contains(target) &&
                !target.closest('[id^="training-dialog-"]')) {
              
              e.preventDefault();
              e.stopPropagation();
              
              // Show component type and name dialog
              const dialog = document.createElement('div');
              dialog.style.cssText = `
                position: fixed !important;
                top: 50% !important;
                left: 50% !important;
                transform: translate(-50%, -50%) !important;
                background: rgba(0, 0, 0, 0.95) !important;
                color: white !important;
                padding: 25px !important;
                border-radius: 8px !important;
                font-family: monospace !important;
                z-index: 2147483648 !important;
                box-shadow: 0 0 20px rgba(0, 0, 0, 0.8) !important;
                min-width: 350px !important;
              `;
              
              const dialogId = `training-dialog-${Date.now()}`;
              dialog.id = dialogId;
              
              dialog.innerHTML = `
                <h3 style="margin: 0 0 15px 0; color: #ffa500;">🎯 Component Training</h3>
                <div style="font-size: 12px; margin-bottom: 15px; color: #aaa;">
                  Element: ${target.tagName.toLowerCase()}.${target.className.split(' ')[0] || 'no-class'}
                </div>
                
                <div style="margin-bottom: 15px;">
                  <label style="display: block; margin-bottom: 5px; color: #ffa500;">Component Type:</label>
                  <select id="component-type" style="
                    width: 100%; padding: 10px; background: #222; color: white; 
                    border: 2px solid #555; border-radius: 6px; font-family: monospace;
                    font-size: 12px; outline: none; cursor: pointer;
                    appearance: none; -webkit-appearance: none; -moz-appearance: none;
                    background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8" viewBox="0 0 12 8"><path fill="%23ffa500" d="M1 1l5 5 5-5"/></svg>');
                    background-repeat: no-repeat; background-position: right 10px center;
                    padding-right: 35px;
                  " onmouseover="this.style.borderColor='#ffa500'" onmouseout="this.style.borderColor='#555'">
                    <option value="modal" style="background: #222; color: white;">Modal</option>
                    <option value="popup" style="background: #222; color: white;">Popup</option>
                    <option value="dialog" style="background: #222; color: white;">Dialog</option>
                    <option value="notification" style="background: #222; color: white;">Notification</option>
                    <option value="tooltip" style="background: #222; color: white;">Tooltip</option>
                    <option value="drawer" style="background: #222; color: white;">Drawer/Sidebar</option>
                    <option value="custom" style="background: #222; color: white;">Custom</option>
                  </select>
                </div>
                
                <div style="margin-bottom: 20px;">
                  <label style="display: block; margin-bottom: 5px; color: #ffa500;">Component Name:</label>
                  <input type="text" id="component-name" placeholder="e.g., Login Modal, Edit Dialog" style="
                    width: 100%; padding: 10px; background: #222; color: white; 
                    border: 2px solid #555; border-radius: 6px; font-family: monospace;
                    box-sizing: border-box; font-size: 12px; outline: none;
                  " onfocus="this.style.borderColor='#ffa500'" onblur="this.style.borderColor='#555'" />
                </div>
                
                <div style="display: flex; gap: 10px;">
                  <button id="save-training" style="
                    flex: 1; padding: 10px; background: #27ae60; color: white; 
                    border: none; border-radius: 4px; cursor: pointer; font-weight: bold;
                  ">Save Training</button>
                  <button id="cancel-training" style="
                    flex: 1; padding: 10px; background: #e74c3c; color: white; 
                    border: none; border-radius: 4px; cursor: pointer;
                  ">Cancel</button>
                </div>
              `;
              
              document.body.appendChild(dialog);
              
              // Focus on name input
              const nameInput = dialog.querySelector('#component-name') as HTMLInputElement;
              nameInput?.focus();
              
              // Stop event propagation for all dialog interactions
              dialog.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
              });
              
              // Handle save
              const saveBtn = dialog.querySelector('#save-training');
              const cancelBtn = dialog.querySelector('#cancel-training');
              
              const saveTraining = (e?: Event) => {
                if (e) {
                  e.stopPropagation();
                  e.preventDefault();
                }
                
                const typeSelect = dialog.querySelector('#component-type') as HTMLSelectElement;
                const componentType = typeSelect?.value || 'modal';
                const componentName = nameInput?.value || `${componentType}_${Date.now()}`;
                
                // Extract training data with type and name
                const trainingData = extractModalFeatures(target) as any;
                trainingData.componentType = componentType;
                trainingData.componentName = componentName;
                
                console.log('[Modal Training] Element selected for training:', JSON.stringify(trainingData));
                
                dialog.remove();
                
                // Show success message
                const success = document.createElement('div');
                success.style.cssText = `
                  position: fixed !important;
                  top: 20px !important;
                  right: 20px !important;
                  background: #27ae60 !important;
                  color: white !important;
                  padding: 15px 20px !important;
                  border-radius: 4px !important;
                  font-family: monospace !important;
                  z-index: 2147483648 !important;
                  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3) !important;
                `;
                success.innerHTML = `✅ Trained: ${componentName} (${componentType})`;
                document.body.appendChild(success);
                
                setTimeout(() => {
                  if (success.parentNode) success.remove();
                }, 3000);
              };
              
              saveBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                saveTraining(e);
              });
              
              cancelBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                dialog.remove();
              });
              
              // Allow Enter to save
              nameInput?.addEventListener('keypress', (e) => {
                e.stopPropagation(); // Prevent training handler from firing
                if (e.key === 'Enter') {
                  e.preventDefault();
                  saveTraining(e);
                }
              });
              
              // Stop propagation for all inputs in dialog
              const typeSelect = dialog.querySelector('#component-type') as HTMLSelectElement;
              typeSelect?.addEventListener('click', (e) => e.stopPropagation());
              typeSelect?.addEventListener('change', (e) => e.stopPropagation());
              nameInput?.addEventListener('click', (e) => e.stopPropagation());
              nameInput?.addEventListener('input', (e) => e.stopPropagation());
            }
          };

          // Add event listeners for highlighting
          document.addEventListener('mouseover', handleMouseOver);

          // Add click handler for training
          document.addEventListener('click', handleTrainingClick, true);
          
          console.log('[Modal Training] Event listeners attached');

          // Extract training features from element
          const extractModalFeatures = (element: Element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            const className = element.className || '';
            
            return {
              tagName: element.tagName.toLowerCase(),
              primaryClass: className.split(' ')[0] || 'no-class',
              allClasses: className,
              id: element.id || null,
              position: style.position,
              zIndex: parseInt(style.zIndex) || 0,
              width: rect.width,
              height: rect.height,
              top: rect.top,
              left: rect.left,
              backgroundColor: style.backgroundColor,
              display: style.display,
              textContent: element.textContent?.substring(0, 100) || '',
              modalScore: calculateModalScore(element),
              hasFormElements: !!element.querySelector('input, button, form, textarea, select'),
              timestamp: new Date().toISOString(),
              url: window.location.href
            };
          };

          // Exit training mode - use a more robust approach
          setTimeout(() => {
            const exitButton = document.getElementById('exit-training');
            console.log('[Modal Training] Setting up exit button:', !!exitButton);
            
            if (exitButton) {
              const exitTraining = (e: Event) => {
                console.log('[Modal Training] Exit function called');
                if (e) {
                  e.preventDefault();
                  e.stopPropagation();
                  e.stopImmediatePropagation(); // Stop all other event listeners
                }
                
                console.log('[Modal Training] Exit button clicked - cleaning up...');
                
                // Remove all training-related elements
                try {
                  // Remove event listeners IMMEDIATELY to prevent interference
                  document.removeEventListener('mouseover', handleMouseOver);
                  document.removeEventListener('click', handleTrainingClick, true);
                  console.log('[Modal Training] Event listeners removed');
                  
                  // Clear any remaining timeouts/intervals
                  if (currentHighlight && currentHighlight.parentNode) {
                    currentHighlight.remove();
                    console.log('[Modal Training] Current highlight removed');
                  }
                  
                  if (trainingOverlay && trainingOverlay.parentNode) {
                    trainingOverlay.remove();
                    console.log('[Modal Training] Training overlay removed');
                  }
                  
                  if (instructionPanel && instructionPanel.parentNode) {
                    instructionPanel.remove();
                    console.log('[Modal Training] Instruction panel removed');
                  }
                  
                  // Notify the browser session that training mode is disabled
                  if ((window as any).notifyTrainingModeExited) {
                    (window as any).notifyTrainingModeExited();
                  }
                  
                  console.log('[Modal Training] Training mode exited successfully');
                } catch (error) {
                  console.error('[Modal Training] Error during cleanup:', error);
                }
              };
              
              // Multiple ways to attach the handler
              exitButton.onclick = exitTraining;
              exitButton.addEventListener('click', exitTraining, true); // Use capture phase
              exitButton.addEventListener('mousedown', exitTraining, true); // Fallback
              
              console.log('[Modal Training] Exit button handlers attached');
            } else {
              console.error('[Modal Training] Exit button not found!');
            }
          }, 100); // Small delay to ensure DOM is ready

          document.body.appendChild(trainingOverlay);
        };



        // Create overlay when DOM is ready
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', (window as any).createDebugOverlay);
        } else {
          (window as any).createDebugOverlay();
        }

        // Also recreate on navigation
        let lastUrl = location.href;
        new MutationObserver(() => {
          if (location.href !== lastUrl) {
            lastUrl = location.href;
            setTimeout((window as any).createDebugOverlay, 100);
          }
        }).observe(document, { subtree: true, childList: true });
      });

      console.log('[Debug Overlay] Persistent overlay script added');
      
      // Also inject immediately as fallback
      await this.injectDebugOverlayDirect();
      
    } catch (error) {
      console.error('[Debug Overlay] Failed to inject persistent overlay:', error);
      // Try fallback method
      await this.injectDebugOverlayDirect();
    }
    
    // Set up console listener (works for both persistent and direct injection)
    this.setupConsoleListener();
  }

  // Direct overlay injection as fallback
  private async injectDebugOverlayDirect() {
    if (!this.page) return;

    try {
      // Pass current training mode state to the overlay
      await this.page.evaluate((isTrainingMode) => {
        // Remove existing overlay if it exists
        const existingOverlay = document.getElementById('crawler-debug-overlay');
        if (existingOverlay) {
          existingOverlay.remove();
        }

        // Create overlay container
        const overlay = document.createElement('div');
        overlay.id = 'crawler-debug-overlay';
        overlay.style.cssText = `
          position: fixed !important;
          top: 10px !important;
          right: 10px !important;
          z-index: 2147483647 !important;
          background: rgba(0, 0, 0, 0.95) !important;
          color: white !important;
          padding: 12px !important;
          border-radius: 8px !important;
          font-family: monospace !important;
          font-size: 12px !important;
          min-width: 200px !important;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5) !important;
          border: 2px solid #ff6b35 !important;
        `;

        // Create title
        const title = document.createElement('div');
        title.textContent = '🔍 Crawler Debug';
        title.style.cssText = `
          font-weight: bold !important;
          margin-bottom: 8px !important;
          color: #ffa500 !important;
          cursor: move !important;
        `;
        overlay.appendChild(title);

        // Create training mode status indicator
        const trainingModeIndicator = document.createElement('div');
        trainingModeIndicator.id = 'training-mode-indicator';
        trainingModeIndicator.style.cssText = `
          display: block !important;
          width: auto !important;
          padding: 2px 6px !important;
          margin: 0 0 4px 0 !important;
          background: ${isTrainingMode ? '#e74c3c' : '#27ae60'} !important;
          color: white !important;
          border: none !important;
          border-radius: 2px !important;
          font-size: 8px !important;
          font-family: monospace !important;
          font-weight: bold !important;
          text-align: center !important;
          white-space: nowrap !important;
          border: 1px solid ${isTrainingMode ? '#c0392b' : '#229954'} !important;
          box-sizing: border-box !important;
        `;
        trainingModeIndicator.textContent = isTrainingMode ? '📚 TRAINING MODE' : '🎥 RECORDING MODE';
        overlay.appendChild(trainingModeIndicator);

        // Create debug modal button
        const debugButton = document.createElement('button');
        debugButton.textContent = 'Debug Modals';
        debugButton.style.cssText = `
          display: block !important;
          width: auto !important;
          padding: 3px 6px !important;
          margin: 0 0 2px 0 !important;
          background: #ff6b35 !important;
          color: white !important;
          border: none !important;
          border-radius: 2px !important;
          cursor: pointer !important;
          font-size: 9px !important;
          font-family: monospace !important;
          white-space: nowrap !important;
        `;
        debugButton.onclick = () => {
          console.log('[Debug Overlay] Manual modal detection triggered');
        };
        overlay.appendChild(debugButton);

        // Create capture button
        const captureButton = document.createElement('button');
        captureButton.textContent = 'Capture Full Screen';
        captureButton.style.cssText = `
          display: block !important;
          width: auto !important;
          padding: 3px 6px !important;
          margin: 0 0 2px 0 !important;
          background: #4a90e2 !important;
          color: white !important;
          border: none !important;
          border-radius: 2px !important;
          cursor: pointer !important;
          font-size: 9px !important;
          font-family: monospace !important;
          white-space: nowrap !important;
        `;
        captureButton.onclick = () => {
          console.log('[Debug Overlay] Manual screenshot capture triggered');
        };
        overlay.appendChild(captureButton);

        // Create capture area button
        const captureAreaButton = document.createElement('button');
        captureAreaButton.textContent = 'Capture Selected Area';
        captureAreaButton.style.cssText = `
          display: block !important;
          width: auto !important;
          padding: 3px 6px !important;
          margin: 0 0 2px 0 !important;
          background: #28a745 !important;
          color: white !important;
          border: none !important;
          border-radius: 2px !important;
          cursor: pointer !important;
          font-size: 9px !important;
          font-family: monospace !important;
          white-space: nowrap !important;
        `;
        captureAreaButton.onclick = () => {
          startAreaSelection();
        };
        overlay.appendChild(captureAreaButton);

        // Create modal training button (direct injection version)
        const trainButtonDirect = document.createElement('button');
        trainButtonDirect.textContent = 'Train Modal Detection';
        trainButtonDirect.style.cssText = `
          display: block !important;
          width: auto !important;
          padding: 3px 6px !important;
          margin: 0 0 2px 0 !important;
          background: #8e44ad !important;
          color: white !important;
          border: none !important;
          border-radius: 2px !important;
          cursor: pointer !important;
          font-size: 9px !important;
          font-family: monospace !important;
          white-space: nowrap !important;
        `;
        trainButtonDirect.onclick = () => {
          console.log('[Debug Overlay] Train Modal Detection button clicked');
          try {
            if (typeof (window as any).startModalTraining === 'function') {
              (window as any).startModalTraining();
            } else {
              console.error('[Debug Overlay] startModalTraining function not found');
            }
          } catch (error) {
            console.error('[Debug Overlay] Error calling startModalTraining:', error);
          }
        };

        // Define deleteTrainedComponent function
        (window as any).deleteTrainedComponent = async (componentId: string) => {
          console.log('[Delete Component] Delete requested for:', componentId);
          
          try {
            // Send message to browser session to handle the deletion
            console.log('[Modal Training] Delete component requested:', componentId);
            
            // Return true for now - the actual deletion will be handled by the browser session
            // when it processes the console message
            return true;
          } catch (error) {
            console.error('[Delete Component] Error:', error);
            return false;
          }
        };

        // Define showTrainedData function

        (window as any).showTrainedData = () => {
          console.log('[Trained Data] Showing trained components');
          
          // Remove any existing panel
          const existing = document.getElementById('trained-data-panel');
          if (existing) existing.remove();
          
          const panel = document.createElement('div');
          panel.id = 'trained-data-panel';
          panel.style.cssText = `
            position: fixed !important;
            top: 50px !important;
            right: 20px !important;
            background: rgba(0, 0, 0, 0.95) !important;
            color: white !important;
            padding: 20px !important;
            border: 2px solid #f39c12 !important;
            border-radius: 8px !important;
            font-family: monospace !important;
            font-size: 12px !important;
            z-index: 999999 !important;
            max-width: 500px !important;
            max-height: 70vh !important;
            overflow-y: auto !important;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5) !important;
          `;
          
          const siteRules = (window as any).siteSpecificModalRules;
          const currentPath = window.location.pathname;
          
          let html = `<h3 style="margin: 0 0 15px 0; color: #f39c12;">📋 Trained Components</h3>`;
          
          if (!siteRules || !siteRules.trainedComponents || siteRules.trainedComponents.length === 0) {
            html += '<div style="color: #e74c3c;">No trained components found for this domain.</div>';
          } else {
            // Show both page-specific and all domain components
            const pageComponents = siteRules.trainedComponents.filter((comp: any) => 
              comp.pagePath === currentPath || comp.pageUrl === window.location.href
            );
            const allComponents = siteRules.trainedComponents;
            
            html += `<div style="margin-bottom: 10px; color: #95a5a6;">
              Domain: ${siteRules.domain}<br>
              Total Components: ${allComponents.length}<br>
              This Page: ${pageComponents.length}
            </div>`;
            
            // Show page-specific components first, then all others
            const componentsToShow = pageComponents.length > 0 ? pageComponents : allComponents;
            
            if (componentsToShow.length === 0) {
              html += '<div style="color: #3498db;">No components trained for this domain.</div>';
            } else {
              if (pageComponents.length === 0 && allComponents.length > 0) {
                html += '<div style="color: #f39c12; margin-bottom: 10px;">Showing all trained components for this domain:</div>';
              }
              html += '<div style="margin-top: 15px;">';
              componentsToShow.forEach((comp: any) => {
                html += `
                  <div style="
                    background: rgba(255, 255, 255, 0.1); 
                    padding: 10px; 
                    margin-bottom: 10px; 
                    border-radius: 4px;
                    border: 1px solid rgba(255, 255, 255, 0.2);
                  ">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                      <div>
                        <strong style="color: #3498db;">${comp.name}</strong>
                        <span style="
                          background: #27ae60; 
                          color: white; 
                          padding: 2px 6px; 
                          border-radius: 3px; 
                          font-size: 10px;
                          margin-left: 8px;
                        ">${comp.type}</span>
                      </div>
                      <button data-component-id="${comp.id}" data-component-name="${comp.name}" class="delete-component-btn" style="
                        background: #e74c3c; 
                        color: white; 
                        border: none; 
                        padding: 4px 8px; 
                        border-radius: 3px; 
                        cursor: pointer;
                        font-size: 10px;
                      ">Delete</button>
                    </div>
                    <div style="font-size: 10px; color: #95a5a6; margin-top: 5px;">
                      Selector: <code style="color: #e67e22;">${comp.selector}</code><br>
                      Created: ${new Date(comp.createdAt).toLocaleString()}
                    </div>
                  </div>
                `;
              });
              html += '</div>';
            }
          }
          
          // Add close button
          html += `
            <div style="text-align: right; margin-top: 15px; border-top: 1px solid #34495e; padding-top: 15px;">
              <button onclick="document.getElementById('trained-data-panel').remove(); return false;" style="
                background: #95a5a6; 
                color: white; 
                border: none; 
                padding: 8px 15px; 
                border-radius: 4px; 
                cursor: pointer;
                font-size: 12px;
              ">Close</button>
            </div>
          `;
          
          panel.innerHTML = html;
          document.body.appendChild(panel);
          
          // Create custom modal confirmation system that bypasses all other event handlers
          const createDeleteModal = (componentId: string, componentName: string) => {
            // Remove any existing delete modal
            const existingModal = document.getElementById('delete-confirmation-modal');
            if (existingModal) existingModal.remove();
            
            // Create modal backdrop
            const backdrop = document.createElement('div');
            backdrop.id = 'delete-confirmation-modal';
            backdrop.style.cssText = `
              position: fixed !important;
              top: 0 !important;
              left: 0 !important;
              width: 100vw !important;
              height: 100vh !important;
              background: rgba(0, 0, 0, 0.8) !important;
              z-index: 2147483647 !important;
              display: flex !important;
              align-items: center !important;
              justify-content: center !important;
            `;
            
            // Create modal content
            const modal = document.createElement('div');
            modal.style.cssText = `
              background: white !important;
              padding: 30px !important;
              border-radius: 8px !important;
              box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5) !important;
              font-family: Arial, sans-serif !important;
              color: black !important;
              text-align: center !important;
              max-width: 400px !important;
            `;
            
            modal.innerHTML = `
              <h3 style="margin: 0 0 20px 0; color: #333;">Confirm Delete</h3>
              <p style="margin: 0 0 30px 0;">Are you sure you want to delete the component: <strong>${componentName}</strong>?</p>
              <div>
                <button id="delete-confirm-yes" style="
                  background: #e74c3c; 
                  color: white; 
                  border: none; 
                  padding: 10px 20px; 
                  border-radius: 4px; 
                  cursor: pointer; 
                  margin-right: 10px;
                  font-size: 14px;
                ">Delete</button>
                <button id="delete-confirm-no" style="
                  background: #95a5a6; 
                  color: white; 
                  border: none; 
                  padding: 10px 20px; 
                  border-radius: 4px; 
                  cursor: pointer;
                  font-size: 14px;
                ">Cancel</button>
              </div>
            `;
            
            backdrop.appendChild(modal);
            document.body.appendChild(backdrop);
            
            // Handle button clicks with direct event listeners
            const yesBtn = document.getElementById('delete-confirm-yes') as HTMLButtonElement;
            const noBtn = document.getElementById('delete-confirm-no') as HTMLButtonElement;
            
            if (yesBtn) {
              yesBtn.addEventListener('click', async () => {
                backdrop.remove();
                console.log('[DELETE MODAL] User confirmed deletion for:', componentId, componentName);
                console.log('[DELETE MODAL] Checking if playwrightDeleteComponent exists:', typeof (window as any).playwrightDeleteComponent);
                try {
                  console.log('[DELETE MODAL] Calling playwrightDeleteComponent...');
                  const result = await (window as any).playwrightDeleteComponent(componentId, componentName);
                  console.log('[DELETE MODAL] Delete result:', result);
                  
                  if (result) {
                    console.log('[DELETE MODAL] Deletion successful');
                  } else {
                    console.log('[DELETE MODAL] Deletion failed');
                  }
                } catch (error) {
                  console.error('[DELETE MODAL] Delete error:', error);
                  alert('Error deleting component: ' + (error as Error).message);
                }
              });
            }
            
            if (noBtn) {
              noBtn.addEventListener('click', () => {
                backdrop.remove();
                console.log('[DELETE MODAL] User cancelled deletion');
              });
            }
            
            // Close on backdrop click
            backdrop.addEventListener('click', (e) => {
              if (e.target === backdrop) {
                backdrop.remove();
                console.log('[DELETE MODAL] User cancelled by clicking backdrop');
              }
            });
          };
          
          // Add click handlers to delete buttons using event delegation on the panel
          panel.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            if (target) {
              const deleteBtn = target.closest('.delete-component-btn') as HTMLElement;
              if (deleteBtn) {
                e.stopPropagation();
                e.preventDefault();
                
                const componentId = deleteBtn.getAttribute('data-component-id');
                const componentName = deleteBtn.getAttribute('data-component-name');
                
                console.log('[DELETE] Delete button clicked for:', componentId, componentName);
                createDeleteModal(componentId, componentName);
              }
            }
          });
        };

        // Create show trained data button
        const showTrainedButton = document.createElement('button');
        showTrainedButton.textContent = 'Show Trained Data';
        showTrainedButton.style.cssText = `
          display: block !important;
          width: auto !important;
          padding: 2px 4px !important;
          margin: 2px 0 0 0 !important;
          background: #f39c12 !important;
          color: white !important;
          border: none !important;
          border-radius: 2px !important;
          cursor: pointer !important;
          font-size: 9px !important;
          font-family: monospace !important;
          white-space: nowrap !important;
        `;
        showTrainedButton.onclick = () => {
          console.log('[Debug Overlay] Show Trained Data button clicked');
          if ((window as any).showTrainedData) {
            (window as any).showTrainedData();
          } else {
            console.error('[Debug Overlay] showTrainedData function not found');
          }
        };

        // Create toggle button
        const toggleButton = document.createElement('button');
        toggleButton.textContent = 'Hide';
        toggleButton.style.cssText = `
          display: block !important;
          width: auto !important;
          padding: 2px 4px !important;
          margin: 2px 0 0 0 !important;
          background: #666 !important;
          color: white !important;
          border: none !important;
          border-radius: 2px !important;
          cursor: pointer !important;
          font-size: 8px !important;
          font-family: monospace !important;
          white-space: nowrap !important;
        `;
        
        let isMinimized = false;
        const content = document.createElement('div');
        content.appendChild(debugButton);
        content.appendChild(captureButton);
        content.appendChild(captureAreaButton);
        content.appendChild(trainButtonDirect);
        content.appendChild(showTrainedButton);
        
        toggleButton.onclick = () => {
          isMinimized = !isMinimized;
          content.style.display = isMinimized ? 'none' : 'block';
          toggleButton.textContent = isMinimized ? 'Show' : 'Hide';
        };
        
        overlay.appendChild(content);
        overlay.appendChild(toggleButton);

        // Add to page
        document.body.appendChild(overlay);

        // Make it draggable
        let isDragging = false;
        let dragOffset = { x: 0, y: 0 };
        
        title.onmousedown = (e) => {
          isDragging = true;
          dragOffset.x = e.clientX - overlay.offsetLeft;
          dragOffset.y = e.clientY - overlay.offsetTop;
          e.preventDefault();
        };
        
        document.onmousemove = (e) => {
          if (isDragging) {
            overlay.style.left = (e.clientX - dragOffset.x) + 'px';
            overlay.style.top = (e.clientY - dragOffset.y) + 'px';
            overlay.style.right = 'auto';
          }
        };
        
        document.onmouseup = () => {
          isDragging = false;
        };

        // Area selection function
        function startAreaSelection() {
          // Remove any existing selection overlay
          const existingSelection = document.getElementById('crawler-selection-overlay');
          if (existingSelection) {
            existingSelection.remove();
          }

          // Create selection overlay
          const selectionOverlay = document.createElement('div');
          selectionOverlay.id = 'crawler-selection-overlay';
          selectionOverlay.style.cssText = `
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            width: 100vw !important;
            height: 100vh !important;
            background: rgba(0, 0, 0, 0.3) !important;
            z-index: 2147483646 !important;
            cursor: crosshair !important;
          `;

          // Create selection box
          const selectionBox = document.createElement('div');
          selectionBox.style.cssText = `
            position: absolute !important;
            border: 2px solid #ff6b35 !important;
            background: rgba(255, 107, 53, 0.1) !important;
            display: none !important;
            pointer-events: none !important;
          `;
          selectionOverlay.appendChild(selectionBox);

          // Create instruction text
          const instructionText = document.createElement('div');
          instructionText.style.cssText = `
            position: fixed !important;
            top: 50% !important;
            left: 50% !important;
            transform: translate(-50%, -50%) !important;
            background: rgba(0, 0, 0, 0.8) !important;
            color: white !important;
            padding: 15px 25px !important;
            border-radius: 8px !important;
            font-family: monospace !important;
            font-size: 14px !important;
            text-align: center !important;
            pointer-events: none !important;
            z-index: 2147483647 !important;
          `;
          instructionText.innerHTML = `
            <div style="margin-bottom: 10px;">📐 Select Area to Capture</div>
            <div style="font-size: 12px; opacity: 0.8;">
              Click and drag to select area<br>
              Press ESC to cancel
            </div>
          `;
          document.body.appendChild(instructionText);

          let isSelecting = false;
          let startX = 0, startY = 0;

          const startSelection = (e: MouseEvent) => {
            isSelecting = true;
            startX = e.clientX;
            startY = e.clientY;
            
            selectionBox.style.left = startX + 'px';
            selectionBox.style.top = startY + 'px';
            selectionBox.style.width = '0px';
            selectionBox.style.height = '0px';
            selectionBox.style.display = 'block';
            
            instructionText.style.display = 'none';
          };

          const updateSelection = (e: MouseEvent) => {
            if (!isSelecting) return;
            
            const currentX = e.clientX;
            const currentY = e.clientY;
            
            const left = Math.min(startX, currentX);
            const top = Math.min(startY, currentY);
            const width = Math.abs(currentX - startX);
            const height = Math.abs(currentY - startY);
            
            selectionBox.style.left = left + 'px';
            selectionBox.style.top = top + 'px';
            selectionBox.style.width = width + 'px';
            selectionBox.style.height = height + 'px';
          };

          const finishSelection = (e: MouseEvent) => {
            if (!isSelecting) return;
            
            const currentX = e.clientX;
            const currentY = e.clientY;
            
            const left = Math.min(startX, currentX);
            const top = Math.min(startY, currentY);
            const width = Math.abs(currentX - startX);
            const height = Math.abs(currentY - startY);
            
            // Only capture if selection is large enough
            if (width > 10 && height > 10) {
              // Adjust coordinates for browser zoom level
              const zoomLevel = window.devicePixelRatio / (window.visualViewport?.scale || 1);
              const adjustedLeft = Math.round(left * zoomLevel);
              const adjustedTop = Math.round(top * zoomLevel);
              const adjustedWidth = Math.round(width * zoomLevel);
              const adjustedHeight = Math.round(height * zoomLevel);
              
              console.log('[Debug Overlay] Area capture triggered: ' + adjustedLeft + ',' + adjustedTop + ' ' + adjustedWidth + 'x' + adjustedHeight);
            }
            
            // Clean up
            selectionOverlay.remove();
            instructionText.remove();
          };

          const cancelSelection = () => {
            selectionOverlay.remove();
            instructionText.remove();
          };

          // Event listeners
          selectionOverlay.addEventListener('mousedown', startSelection);
          selectionOverlay.addEventListener('mousemove', updateSelection);
          selectionOverlay.addEventListener('mouseup', finishSelection);
          
          // ESC key to cancel
          const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
              cancelSelection();
              document.removeEventListener('keydown', handleKeyDown);
            }
          };
          document.addEventListener('keydown', handleKeyDown);
          
          document.body.appendChild(selectionOverlay);
        }

        // Define the complete training functions (copied from injectPersistentDebugOverlay)
        (window as any).startModalTraining = () => {
          console.log('[Modal Training] Starting element selection mode');
          
          // Remove any existing training overlay
          const existingTraining = document.getElementById('modal-training-overlay');
          if (existingTraining) existingTraining.remove();

          // Create training overlay
          const trainingOverlay = document.createElement('div');
          trainingOverlay.id = 'modal-training-overlay';
          trainingOverlay.style.cssText = `
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            width: 100vw !important;
            height: 100vh !important;
            pointer-events: none !important;
            z-index: 2147483645 !important;
          `;

          // Create instruction panel
          const instructionPanel = document.createElement('div');
          instructionPanel.id = 'training-instruction-panel';
          instructionPanel.style.cssText = `
            position: fixed !important;
            top: 20px !important;
            left: 50% !important;
            transform: translateX(-50%) !important;
            background: rgba(0, 0, 0, 0.9) !important;
            color: white !important;
            padding: 15px 25px !important;
            border-radius: 8px !important;
            font-family: monospace !important;
            font-size: 14px !important;
            text-align: center !important;
            pointer-events: auto !important;
            z-index: 2147483647 !important;
            max-width: 500px !important;
          `;
          instructionPanel.innerHTML = `
            <div style="margin-bottom: 10px; font-weight: bold;">🎯 Modal Training Mode</div>
            <div style="font-size: 12px; opacity: 0.9; line-height: 1.4;">
              Hover over elements to see colored borders.<br>
              Click on modal elements to train the detection system.<br>
              <span style="color: #ff6b35;">Orange</span> = High modal potential | 
              <span style="color: #f39c12;">Yellow</span> = Medium | 
              <span style="color: #3498db;">Blue</span> = Low
            </div>
            <button id="exit-training" style="
              margin-top: 10px; padding: 5px 15px; background: #e74c3c; 
              color: white; border: none; border-radius: 4px; cursor: pointer;
              pointer-events: auto !important; z-index: 2147483649 !important;
            ">Exit Training</button>
          `;
          document.body.appendChild(instructionPanel);

          // Add element highlighting on mouseover
          let currentHighlight: HTMLElement | null = null;
          const highlightElement = (element: Element) => {
            if (currentHighlight) {
              currentHighlight.remove();
            }

            const rect = element.getBoundingClientRect();
            const highlight = document.createElement('div');
            
            // Calculate modal score for color coding
            const modalScore = calculateModalScore(element);
            let borderColor = '#3498db'; // Blue for low score
            if (modalScore > 70) borderColor = '#ff6b35'; // Orange for high score
            else if (modalScore > 40) borderColor = '#f39c12'; // Yellow for medium score

            highlight.style.cssText = `
              position: fixed !important;
              top: ${rect.top}px !important;
              left: ${rect.left}px !important;
              width: ${rect.width}px !important;
              height: ${rect.height}px !important;
              border: 3px solid ${borderColor} !important;
              background: ${borderColor}22 !important;
              pointer-events: none !important;
              z-index: 2147483646 !important;
              border-radius: 4px !important;
            `;
            
            trainingOverlay.appendChild(highlight);
            currentHighlight = highlight;

            // Show element info
            const info = document.createElement('div');
            info.style.cssText = `
              position: fixed !important;
              top: ${rect.bottom + 5}px !important;
              left: ${rect.left}px !important;
              background: rgba(0, 0, 0, 0.8) !important;
              color: white !important;
              padding: 5px 10px !important;
              border-radius: 4px !important;
              font-family: monospace !important;
              font-size: 11px !important;
              z-index: 2147483647 !important;
            `;
            info.textContent = `${element.tagName.toLowerCase()}${element.className ? '.' + element.className.split(' ').slice(0,2).join('.') : ''} (Score: ${modalScore})`;
            trainingOverlay.appendChild(info);
            
            setTimeout(() => info.remove(), 3000);
          };

          // Modal score calculation function
          const calculateModalScore = (element: Element) => {
            let score = 0;
            const tagName = element.tagName.toLowerCase();
            const className = element.className || '';
            const id = element.id || '';
            const role = element.getAttribute('role') || '';
            
            // Tag-based scoring
            if (tagName === 'dialog') score += 50;
            if (tagName === 'div') score += 10;
            if (tagName === 'section') score += 15;
            if (tagName === 'aside') score += 20;
            
            // Class-based scoring
            if (className.includes('modal')) score += 40;
            if (className.includes('dialog')) score += 40;
            if (className.includes('popup')) score += 35;
            if (className.includes('overlay')) score += 30;
            if (className.includes('lightbox')) score += 35;
            if (className.includes('backdrop')) score += 25;
            
            // Role-based scoring
            if (role === 'dialog') score += 45;
            if (role === 'modal') score += 45;
            if (role === 'alertdialog') score += 40;
            
            // ID-based scoring
            if (id.includes('modal')) score += 35;
            if (id.includes('dialog')) score += 35;
            if (id.includes('popup')) score += 30;
            
            // Style-based scoring
            const style = window.getComputedStyle(element);
            if (style.position === 'fixed') score += 20;
            if (style.position === 'absolute') score += 15;
            if (style.zIndex && parseInt(style.zIndex) > 100) score += 10;
            
            return Math.min(score, 100);
          };

          document.body.appendChild(trainingOverlay);

          // Mouseover handler for highlighting
          const mouseoverHandler = (e: MouseEvent) => {
            if ((e.target as Element)?.closest('#training-instruction-panel')) return;
            if (e.target) highlightElement(e.target as Element);
          };

          // Training click handler
          const handleTrainingClick = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (!target) return;
            
            console.log('[Training DEBUG] Click event captured on:', target.tagName, target.className, target.id);
            
            // CRITICAL: If click is anywhere within the trained-data-panel, don't interfere AT ALL
            if (target.closest('#trained-data-panel')) {
              console.log('[Training] COMPLETELY IGNORING click within trained-data-panel - no interference');
              return; // Early exit - don't prevent default, don't stop propagation
            }
            
            // Double-check: If this is a delete button anywhere, never interfere
            if (target.textContent?.includes('Delete') || target.onclick?.toString()?.includes('playwrightDeleteComponent')) {
              console.log('[Training] COMPLETELY IGNORING delete button click - no interference');
              return;
            }
            
            // Additional check: if target has onclick that calls exposed functions, ignore
            if (target.onclick && target.onclick.toString().includes('window.playwright')) {
              console.log('[Training] IGNORING click on element with exposed Playwright function');
              return;
            }
            
            // Add detailed debugging for delete buttons
            if (target.classList.contains('trained-data-delete-btn')) {
              console.log('[DELETE DEBUG] Training handler caught delete button click!');
              console.log('[DELETE DEBUG] Target classes:', target.className);
              return; // Early exit for delete buttons
            }
            
            console.log('[Modal Training] Click captured on:', target.tagName, target.id, target.className);
            
            // Check if we should skip this element BEFORE preventing default
            const shouldSkip = (
              target.id === 'exit-training' ||
              target.closest('#training-instruction-panel') ||
              target.closest('[id^="modal-training-dialog"]') ||
              (target.tagName === 'BUTTON' && target.closest('[id^="modal-training-dialog"]')) ||
              target.id === 'save-training-btn' ||
              target.id === 'cancel-training-btn' ||
              target.closest('#simple-discovery')
            );
            
            if (shouldSkip) {
              console.log('[Modal Training] Skipping training handler for this element');
              return; // Don't prevent default for excluded elements
            }
            
            // Only prevent default for elements we want to train
            e.preventDefault();
            e.stopPropagation();
            
            // At this point, we've already checked if we should skip, so proceed with training
            
            // Serialize element data for training
            const elementData = {
              tagName: target.tagName,
              className: target.className,
              id: target.id,
              textContent: target.textContent?.slice(0, 100) || '', // Limit text length
              attributes: Array.from(target.attributes).reduce((acc, attr) => {
                acc[attr.name] = attr.value;
                return acc;
              }, {} as Record<string, string>)
            };
            console.log('[Modal Training] Element selected for training:', JSON.stringify(elementData));
            
            // Calculate modal features
            const modalScore = calculateModalScore(target as Element);
            
            // Remove any existing training dialogs to prevent duplicates
            const existingDialogs = document.querySelectorAll('[id^="modal-training-dialog"]');
            existingDialogs.forEach(existingDialog => existingDialog.remove());
            
            // Create training dialog
            const dialogId = 'modal-training-dialog-' + Date.now(); // Unique ID for cleanup
            const dialog = document.createElement('div');
            dialog.id = dialogId;
            dialog.style.cssText = `
              position: fixed !important;
              top: 50% !important;
              left: 50% !important;
              transform: translate(-50%, -50%) !important;
              background: white !important;
              border: 2px solid #333 !important;
              border-radius: 8px !important;
              padding: 20px !important;
              z-index: 2147483648 !important;
              max-width: 400px !important;
              font-family: Arial, sans-serif !important;
              color: black !important;
            `;
            
            dialog.innerHTML = `
              <h3 style="margin: 0 0 15px 0; color: #333;">Train Modal Component</h3>
              <p><strong>Element:</strong> ${target.tagName?.toLowerCase() || 'unknown'}${target.className ? '.' + target.className.split(' ').slice(0,2).join('.') : ''}</p>
              <p><strong>Modal Score:</strong> ${modalScore}/100</p>
              <div style="margin: 15px 0;">
                <label for="component-type">Component Type:</label><br>
                <select id="component-type" style="width: 100%; padding: 5px; margin-top: 5px;">
                  <option value="modal">Modal Dialog</option>
                  <option value="popup">Popup</option>
                  <option value="tooltip">Tooltip</option>
                  <option value="dropdown">Dropdown</option>
                  <option value="sidebar">Sidebar</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div style="margin: 15px 0;">
                <label for="component-name">Component Name:</label><br>
                <input type="text" id="component-name" placeholder="e.g., Login Modal" style="width: 100%; padding: 5px; margin-top: 5px;">
              </div>
              <div style="text-align: right; margin-top: 20px;">
                <button id="save-training-btn" type="button" style="background: #27ae60; color: white; border: none; padding: 8px 15px; border-radius: 4px; margin-right: 10px; cursor: pointer;">Save</button>
                <button id="cancel-training-btn" type="button" style="background: #95a5a6; color: white; border: none; padding: 8px 15px; border-radius: 4px; cursor: pointer;">Cancel</button>
              </div>
            `;
            
            document.body.appendChild(dialog);
            
            // Get the buttons and attach handlers
            const saveBtn = dialog.querySelector('#save-training-btn') as HTMLButtonElement;
            const cancelBtn = dialog.querySelector('#cancel-training-btn') as HTMLButtonElement;
            
            console.log('[Modal Training] Buttons found:', { 
              saveBtn: !!saveBtn, 
              cancelBtn: !!cancelBtn,
              dialogInDOM: document.body.contains(dialog),
              dialogId: dialog.id
            });
            
            // Save button handler - use capture mode to run before training handler
            if (saveBtn) {
              saveBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                e.preventDefault();
                
                console.log('[Modal Training] Save button clicked');
                
                try {
                  const componentType = (dialog.querySelector('#component-type') as HTMLSelectElement)?.value || 'modal';
                  const componentName = (dialog.querySelector('#component-name') as HTMLInputElement)?.value || 'Unnamed Component';
                  
                  console.log('[Modal Training] Saving:', { componentType, componentName });
                  
                  // Create training data
                  const rect = target.getBoundingClientRect();
                  const trainingData = {
                    componentType: componentType,
                    componentName: componentName,
                    tagName: target.tagName,
                    className: target.className,
                    id: target.id,
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                    height: rect.height,
                    zIndex: window.getComputedStyle(target).zIndex,
                    position: window.getComputedStyle(target).position,
                    modalScore: modalScore
                  };
                  
                  // Log the training data to be captured by the browser session
                  console.log('[Modal Training] Element selected for training:', JSON.stringify(trainingData));
                  
                  // Remove dialog
                  console.log('[Modal Training] Removing dialog');
                  dialog.remove();
                  
                  // Show success message
                  const msg = document.createElement('div');
                  msg.style.cssText = 'position: fixed !important; top: 20px !important; right: 20px !important; background: #27ae60 !important; color: white !important; padding: 15px 20px !important; border-radius: 5px !important; z-index: 2147483649 !important; font-family: Arial, sans-serif !important; font-size: 14px !important;';
                  msg.textContent = 'Training data saved for: ' + componentName;
                  document.body.appendChild(msg);
                  setTimeout(() => msg.remove(), 3000);
                  
                } catch (error) {
                  console.error('[Modal Training] Error:', error);
                  alert('Error saving training data');
                }
              });
            }
            
            // Cancel button handler
            if (cancelBtn) {
              cancelBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                e.preventDefault();
                console.log('[Modal Training] Cancel button clicked');
                dialog.remove();
              });
            }
            
            // Prevent training clicks on dialog
            dialog.addEventListener('click', (e) => {
              e.stopPropagation(); // Prevent clicks from bubbling to page handlers
            });
          };

          // Remove any existing training click handler first
          if ((window as any).trainingClickHandler) {
            console.log('[Training] Removing existing training click handler');
            document.removeEventListener('click', (window as any).trainingClickHandler, false);
          }
          
          // Add event listeners for highlighting
          document.addEventListener('mouseover', mouseoverHandler);
          
          // Add click handler for training and store reference (using bubble phase, not capture)
          console.log('[Training] Adding NEW training click handler in BUBBLE phase');
          document.addEventListener('click', handleTrainingClick, false); // false = bubble phase
          (window as any).trainingClickHandler = handleTrainingClick;
          
          console.log('[Modal Training] Event listeners attached');

          // Multiple ways to attach the exit handler
          const exitButton = instructionPanel.querySelector('#exit-training');
          if (exitButton) {
            const exitTraining = () => {
              console.log('[Modal Training] Exit training called');
              
              if (instructionPanel && instructionPanel.parentNode) {
                instructionPanel.remove();
                console.log('[Modal Training] Instruction panel removed');
              }
              
              // Notify the browser session that training mode is disabled
              if ((window as any).notifyTrainingModeExited) {
                (window as any).notifyTrainingModeExited();
              }
              
              console.log('[Modal Training] Training mode exited successfully');
              document.removeEventListener('mouseover', mouseoverHandler);
              document.removeEventListener('click', handleTrainingClick, false);
              trainingOverlay.remove();
            };
            
            // Multiple ways to attach the handler
            (exitButton as HTMLElement).onclick = exitTraining;
            exitButton.addEventListener('click', exitTraining, true); // Use capture phase
            exitButton.addEventListener('mousedown', exitTraining, true); // Fallback
            
            console.log('[Modal Training] Exit button handlers attached');
          } else {
            console.error('[Modal Training] Exit button not found!');
          }
        };


        // Delete trained component function
        (window as any).deleteTrainedComponent = async (componentId: string) => {
          console.log('[Delete Component] Delete requested for:', componentId);
          
          try {
            // Send message to browser session to handle the deletion
            console.log('[Modal Training] Delete component requested:', componentId);
            
            // Return true for now - the actual deletion will be handled by the browser session
            // when it processes the console message
            return true;
          } catch (error) {
            console.error('[Delete Component] Error:', error);
            return false;
          }
        };

        console.log('[Debug Overlay] Direct overlay injected');
      }, this.isTrainingMode);

      console.log('[Debug Overlay] Direct injection completed');
      
    } catch (error) {
      console.error('[Debug Overlay] Failed to inject direct overlay:', error);
    }
  }

  // Set up console listener for overlay interactions
  private setupConsoleListener() {
    if (!this.page) return;

    // Listen for messages from the overlay and handle them directly
    this.page.on('console', async (msg) => {
      const text = msg.text();
      if (text === '[Debug Overlay] Manual modal detection triggered') {
        console.log('[Debug Overlay] Debug modals triggered from page');
        try {
          const debugResult = await this.debugCurrentModals();
          await this.triggerModalDetection();
          console.log('[Debug Overlay] Modal debug completed');
        } catch (error) {
          console.error('[Debug Overlay] Debug error:', error);
        }
      } else if (text === '[Debug Overlay] Manual screenshot capture triggered') {
        console.log('[Debug Overlay] Manual capture triggered from page');
        try {
          // Hide overlay before capture
          await this.page?.evaluate(() => {
            const overlay = document.getElementById('crawler-debug-overlay');
            if (overlay) overlay.style.display = 'none';
          });
          
          await this.manualCapture();
          
          // Show overlay after capture
          await this.page?.evaluate(() => {
            const overlay = document.getElementById('crawler-debug-overlay');
            if (overlay) overlay.style.display = 'block';
          });
          
          console.log('[Debug Overlay] Manual capture completed');
        } catch (error) {
          console.error('[Debug Overlay] Capture error:', error);
        }
      } else if (text.startsWith('[Debug Overlay] Area capture triggered:')) {
        // Parse the area coordinates from the console message
        const match = text.match(/Area capture triggered: (\d+),(\d+) (\d+)x(\d+)/);
        if (match) {
          const [, x, y, width, height] = match.map(Number);
          console.log(`[Debug Overlay] Area capture triggered: ${x},${y} ${width}x${height}`);
          try {
            // Hide overlay before capture
            await this.page?.evaluate(() => {
              const overlay = document.getElementById('crawler-debug-overlay');
              if (overlay) overlay.style.display = 'none';
            });
            
            await this.manualCapture({ x, y, width, height });
            
            // Show overlay after capture
            await this.page?.evaluate(() => {
              const overlay = document.getElementById('crawler-debug-overlay');
              if (overlay) overlay.style.display = 'block';
            });
            
            console.log('[Debug Overlay] Area capture completed');
          } catch (error) {
            console.error('[Debug Overlay] Area capture error:', error);
          }
        }
      } else if (text.startsWith('[Modal Training] Element selected for training:')) {
        // Handle modal training data
        console.log('[Debug Overlay] Training data received from browser');
        try {
          // Store training data for improving detection
          await this.storeModalTrainingData(text);
        } catch (error) {
          console.error('[Debug Overlay] Training data storage error:', error);
        }
      } else if (text.startsWith('[Modal Training] Delete component requested:')) {
        // Handle delete component request
        const match = text.match(/Delete component requested: (.+)$/);
        if (match) {
          const componentId = match[1];
          console.log('[Debug Overlay] Processing delete request for:', componentId);
          try {
            await this.deleteTrainedComponent(componentId);
            console.log('[Debug Overlay] Component deleted successfully');
          } catch (error) {
            console.error('[Debug Overlay] Delete component error:', error);
          }
        }
      }
    });

    console.log('[Debug Overlay] Console listener set up');
  }

  // Old inject debug overlay method (keeping for reference)
  private async injectDebugOverlay() {
    if (!this.page) return;

    try {
      await this.page.evaluate(() => {
        // Remove existing overlay if it exists
        const existingOverlay = document.getElementById('crawler-debug-overlay');
        if (existingOverlay) {
          existingOverlay.remove();
        }

        // Create overlay container
        const overlay = document.createElement('div');
        overlay.id = 'crawler-debug-overlay';
        overlay.style.cssText = `
          position: fixed;
          top: 10px;
          right: 10px;
          z-index: 999999;
          background: rgba(0, 0, 0, 0.9);
          color: white;
          padding: 10px;
          border-radius: 8px;
          font-family: monospace;
          font-size: 12px;
          min-width: 200px;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        `;

        // Create title
        const title = document.createElement('div');
        title.textContent = '🔍 Crawler Debug';
        title.style.cssText = `
          font-weight: bold;
          margin-bottom: 8px;
          color: #ffa500;
        `;
        overlay.appendChild(title);

        // Create debug modal button
        const debugButton = document.createElement('button');
        debugButton.textContent = 'Debug Modals';
        debugButton.style.cssText = `
          width: 100%;
          padding: 6px 12px;
          margin-bottom: 4px;
          background: #ff6b35;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 11px;
        `;
        debugButton.onclick = () => {
          // Trigger modal detection debug
          console.log('[Debug Overlay] Manual modal detection triggered');
        };
        overlay.appendChild(debugButton);

        // Create capture button
        const captureButton = document.createElement('button');
        captureButton.textContent = 'Capture Full Screen';
        captureButton.style.cssText = `
          width: 100%;
          padding: 6px 12px;
          margin-bottom: 4px;
          background: #4a90e2;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 11px;
        `;
        captureButton.onclick = () => {
          console.log('[Debug Overlay] Manual screenshot capture triggered');
        };
        overlay.appendChild(captureButton);

        // Create capture area button
        const captureAreaButton = document.createElement('button');
        captureAreaButton.textContent = 'Capture Selected Area';
        captureAreaButton.style.cssText = `
          width: 100%;
          padding: 6px 12px;
          margin-bottom: 4px;
          background: #28a745;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 11px;
        `;
        captureAreaButton.onclick = () => {
          (window as any).startAreaSelection();
        };
        overlay.appendChild(captureAreaButton);

        // Create toggle button
        const toggleButton = document.createElement('button');
        toggleButton.textContent = 'Hide';
        toggleButton.style.cssText = `
          width: 100%;
          padding: 4px 8px;
          background: #666;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 10px;
        `;
        
        let isMinimized = false;
        const content = document.createElement('div');
        content.appendChild(debugButton);
        content.appendChild(captureButton);
        content.appendChild(captureAreaButton);
        
        toggleButton.onclick = () => {
          isMinimized = !isMinimized;
          content.style.display = isMinimized ? 'none' : 'block';
          toggleButton.textContent = isMinimized ? 'Show' : 'Hide';
        };
        
        overlay.appendChild(content);
        overlay.appendChild(toggleButton);

        // Add to page
        document.body.appendChild(overlay);

        // Make it draggable
        let isDragging = false;
        let dragOffset = { x: 0, y: 0 };
        
        title.style.cursor = 'move';
        title.onmousedown = (e) => {
          isDragging = true;
          dragOffset.x = e.clientX - overlay.offsetLeft;
          dragOffset.y = e.clientY - overlay.offsetTop;
        };
        
        document.onmousemove = (e) => {
          if (isDragging) {
            overlay.style.left = (e.clientX - dragOffset.x) + 'px';
            overlay.style.top = (e.clientY - dragOffset.y) + 'px';
            overlay.style.right = 'auto';
          }
        };
        
        document.onmouseup = () => {
          isDragging = false;
        };

        // Add area selection functionality
        (window as any).startAreaSelection = () => {
          // Remove any existing selection overlay
          const existingSelection = document.getElementById('crawler-selection-overlay');
          if (existingSelection) {
            existingSelection.remove();
          }

          // Create selection overlay
          const selectionOverlay = document.createElement('div');
          selectionOverlay.id = 'crawler-selection-overlay';
          selectionOverlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background: rgba(0, 0, 0, 0.3);
            z-index: 999998;
            cursor: crosshair;
          `;

          // Create selection box
          const selectionBox = document.createElement('div');
          selectionBox.id = 'crawler-selection-box';
          selectionBox.style.cssText = `
            position: absolute;
            border: 2px solid #ff6b35;
            background: rgba(255, 107, 53, 0.1);
            display: none;
            pointer-events: none;
          `;
          selectionOverlay.appendChild(selectionBox);

          // Create instruction text
          const instructionText = document.createElement('div');
          instructionText.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 15px 25px;
            border-radius: 8px;
            font-family: monospace;
            font-size: 14px;
            text-align: center;
            pointer-events: none;
            z-index: 1000000;
          `;
          instructionText.innerHTML = `
            <div style="margin-bottom: 10px;">📐 Select Area to Capture</div>
            <div style="font-size: 12px; opacity: 0.8;">
              Click and drag to select area<br>
              Press ESC to cancel
            </div>
          `;
          document.body.appendChild(instructionText);

          let isSelecting = false;
          let startX = 0, startY = 0;

          const startSelection = (e: MouseEvent) => {
            isSelecting = true;
            startX = e.clientX;
            startY = e.clientY;
            
            selectionBox.style.left = startX + 'px';
            selectionBox.style.top = startY + 'px';
            selectionBox.style.width = '0px';
            selectionBox.style.height = '0px';
            selectionBox.style.display = 'block';
            
            instructionText.style.display = 'none';
          };

          const updateSelection = (e: MouseEvent) => {
            if (!isSelecting) return;
            
            const currentX = e.clientX;
            const currentY = e.clientY;
            
            const left = Math.min(startX, currentX);
            const top = Math.min(startY, currentY);
            const width = Math.abs(currentX - startX);
            const height = Math.abs(currentY - startY);
            
            selectionBox.style.left = left + 'px';
            selectionBox.style.top = top + 'px';
            selectionBox.style.width = width + 'px';
            selectionBox.style.height = height + 'px';
          };

          const finishSelection = (e: MouseEvent) => {
            if (!isSelecting) return;
            
            const currentX = e.clientX;
            const currentY = e.clientY;
            
            const left = Math.min(startX, currentX);
            const top = Math.min(startY, currentY);
            const width = Math.abs(currentX - startX);
            const height = Math.abs(currentY - startY);
            
            // Only capture if selection is large enough
            if (width > 10 && height > 10) {
              console.log('[Debug Overlay] Area capture triggered: ' + left + ',' + top + ' ' + width + 'x' + height);
            }
            
            // Clean up
            selectionOverlay.remove();
            instructionText.remove();
          };

          const cancelSelection = () => {
            selectionOverlay.remove();
            instructionText.remove();
          };

          // Event listeners
          selectionOverlay.addEventListener('mousedown', startSelection);
          selectionOverlay.addEventListener('mousemove', updateSelection);
          selectionOverlay.addEventListener('mouseup', finishSelection);
          
          // ESC key to cancel
          const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
              cancelSelection();
              document.removeEventListener('keydown', handleKeyDown);
            }
          };
          document.addEventListener('keydown', handleKeyDown);
          
          document.body.appendChild(selectionOverlay);
        };

        console.log('[Debug Overlay] Injected into page');
      });


    } catch (error) {
      console.error('[Debug Overlay] Failed to inject overlay:', error);
    }
  }

  // Create a custom HTML page with debug controls and iframe
  private async createDebugWrapperPage(targetUrl: string) {
    if (!this.page) return;

    const wrapperHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Crawler Debug Session</title>
    <style>
        body {
            margin: 0;
            padding: 0;
            font-family: monospace;
            overflow: hidden;
        }
        
        #debug-panel {
            position: fixed;
            top: 10px;
            right: 10px;
            z-index: 999999;
            background: rgba(0, 0, 0, 0.9);
            color: white;
            padding: 15px;
            border-radius: 8px;
            min-width: 220px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        }
        
        #debug-panel h3 {
            margin: 0 0 12px 0;
            color: #ffa500;
            font-size: 14px;
        }
        
        #debug-panel button {
            width: 100%;
            padding: 8px 12px;
            margin-bottom: 6px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 11px;
            font-family: monospace;
        }
        
        .debug-btn { background: #ff6b35; color: white; }
        .capture-btn { background: #4a90e2; color: white; }
        .area-btn { background: #28a745; color: white; }
        .toggle-btn { background: #666; color: white; font-size: 10px; }
        
        #debug-panel button:hover {
            opacity: 0.8;
        }
        
        #site-iframe {
            width: 100vw;
            height: 100vh;
            border: none;
            background: white;
        }
        
        #fallback-message {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(255, 255, 255, 0.95);
            padding: 20px;
            border-radius: 8px;
            text-align: center;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
            z-index: 999996;
            display: none;
        }
        
        #debug-content {
            display: block;
        }
        
        .minimized #debug-content {
            display: none;
        }
        
        #url-bar {
            position: fixed;
            bottom: 10px;
            left: 10px;
            right: 10px;
            background: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 8px 12px;
            border-radius: 4px;
            font-size: 11px;
            z-index: 999998;
        }
    </style>
</head>
<body>
    <iframe id="site-iframe" src="${targetUrl}" allow="*" sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-top-navigation"></iframe>
    
    <div id="fallback-message">
        <h3>⚠️ Iframe Loading Issue</h3>
        <p>The site cannot be loaded in an iframe due to security restrictions.</p>
        <p><strong>Solution:</strong> Use the separate browser window that opened for interaction.</p>
        <p>The debug controls above will still work with that window.</p>
    </div>
    
    <div id="debug-panel">
        <h3>🔍 Crawler Debug</h3>
        <div id="debug-content">
            <button class="debug-btn" onclick="debugModals()">Debug Modals</button>
            <button class="capture-btn" onclick="captureFullScreen()">Capture Full Screen</button>
            <button class="area-btn" onclick="captureSelectedArea()">Capture Selected Area</button>
        </div>
        <button class="toggle-btn" onclick="togglePanel()">Hide</button>
    </div>
    
    <div id="url-bar">
        <span id="current-url">${targetUrl}</span>
    </div>

    <script>
        let isMinimized = false;
        
        function togglePanel() {
            isMinimized = !isMinimized;
            const panel = document.getElementById('debug-panel');
            const button = panel.querySelector('.toggle-btn');
            
            if (isMinimized) {
                panel.classList.add('minimized');
                button.textContent = 'Show';
            } else {
                panel.classList.remove('minimized');
                button.textContent = 'Hide';
            }
        }
        
        function debugModals() {
            console.log('[Debug Overlay] Manual modal detection triggered');
        }
        
        function captureFullScreen() {
            console.log('[Debug Overlay] Manual screenshot capture triggered');
        }
        
        function captureSelectedArea() {
            startAreaSelection();
        }
        
        function startAreaSelection() {
            // Remove any existing selection overlay
            const existingSelection = document.getElementById('selection-overlay');
            if (existingSelection) {
                existingSelection.remove();
            }

            // Create selection overlay
            const selectionOverlay = document.createElement('div');
            selectionOverlay.id = 'selection-overlay';
            selectionOverlay.style.cssText = \`
                position: fixed;
                top: 0;
                left: 0;
                width: 100vw;
                height: 100vh;
                background: rgba(0, 0, 0, 0.3);
                z-index: 999997;
                cursor: crosshair;
            \`;

            // Create selection box
            const selectionBox = document.createElement('div');
            selectionBox.style.cssText = \`
                position: absolute;
                border: 2px solid #ff6b35;
                background: rgba(255, 107, 53, 0.1);
                display: none;
                pointer-events: none;
            \`;
            selectionOverlay.appendChild(selectionBox);

            // Create instruction text
            const instructionText = document.createElement('div');
            instructionText.style.cssText = \`
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: rgba(0, 0, 0, 0.8);
                color: white;
                padding: 15px 25px;
                border-radius: 8px;
                font-family: monospace;
                font-size: 14px;
                text-align: center;
                pointer-events: none;
                z-index: 1000000;
            \`;
            instructionText.innerHTML = \`
                <div style="margin-bottom: 10px;">📐 Select Area to Capture</div>
                <div style="font-size: 12px; opacity: 0.8;">
                    Click and drag to select area<br>
                    Press ESC to cancel
                </div>
            \`;
            document.body.appendChild(instructionText);

            let isSelecting = false;
            let startX = 0, startY = 0;

            const startSelection = (e: MouseEvent) => {
                isSelecting = true;
                startX = e.clientX;
                startY = e.clientY;
                
                selectionBox.style.left = startX + 'px';
                selectionBox.style.top = startY + 'px';
                selectionBox.style.width = '0px';
                selectionBox.style.height = '0px';
                selectionBox.style.display = 'block';
                
                instructionText.style.display = 'none';
            };

            const updateSelection = (e: MouseEvent) => {
                if (!isSelecting) return;
                
                const currentX = e.clientX;
                const currentY = e.clientY;
                
                const left = Math.min(startX, currentX);
                const top = Math.min(startY, currentY);
                const width = Math.abs(currentX - startX);
                const height = Math.abs(currentY - startY);
                
                selectionBox.style.left = left + 'px';
                selectionBox.style.top = top + 'px';
                selectionBox.style.width = width + 'px';
                selectionBox.style.height = height + 'px';
            };

            const finishSelection = (e: MouseEvent) => {
                if (!isSelecting) return;
                
                const currentX = e.clientX;
                const currentY = e.clientY;
                
                const left = Math.min(startX, currentX);
                const top = Math.min(startY, currentY);
                const width = Math.abs(currentX - startX);
                const height = Math.abs(currentY - startY);
                
                // Only capture if selection is large enough
                if (width > 10 && height > 10) {
                    console.log('[Debug Overlay] Area capture triggered: ' + left + ',' + top + ' ' + width + 'x' + height);
                }
                
                // Clean up
                selectionOverlay.remove();
                instructionText.remove();
            };

            const cancelSelection = () => {
                selectionOverlay.remove();
                instructionText.remove();
            };

            // Event listeners
            selectionOverlay.addEventListener('mousedown', startSelection);
            selectionOverlay.addEventListener('mousemove', updateSelection);
            selectionOverlay.addEventListener('mouseup', finishSelection);
            
            // ESC key to cancel
            const handleKeyDown = (e: KeyboardEvent) => {
                if (e.key === 'Escape') {
                    cancelSelection();
                    document.removeEventListener('keydown', handleKeyDown);
                }
            };
            document.addEventListener('keydown', handleKeyDown);
            
            document.body.appendChild(selectionOverlay);
        }
        
        // Handle iframe loading and show fallback if needed
        const iframe = document.getElementById('site-iframe');
        const fallbackMessage = document.getElementById('fallback-message');
        
        iframe.addEventListener('load', () => {
            try {
                const urlBar = document.getElementById('current-url');
                if (iframe.contentDocument) {
                    urlBar.textContent = iframe.contentWindow.location.href;
                    fallbackMessage.style.display = 'none';
                } else {
                    // Iframe blocked - show fallback message
                    fallbackMessage.style.display = 'block';
                    urlBar.textContent = '${targetUrl} (in separate window)';
                }
            } catch (e) {
                // Cross-origin restrictions - show fallback
                fallbackMessage.style.display = 'block';
                const urlBar = document.getElementById('current-url');
                urlBar.textContent = '${targetUrl} (in separate window)';
                console.log('Iframe blocked - using separate window mode');
            }
        });
        
        // Check if iframe loads after a delay
        setTimeout(() => {
            try {
                if (!iframe.contentDocument || iframe.contentDocument.body.children.length === 0) {
                    fallbackMessage.style.display = 'block';
                }
            } catch (e) {
                fallbackMessage.style.display = 'block';
            }
        }, 3000);
    </script>
</body>
</html>
    `;

    await this.page.setContent(wrapperHtml);
    console.log('[Debug Wrapper] Custom wrapper page created with iframe');
  }

  // Get the current URL from the iframe
  private async getIframeUrl(): Promise<string | null> {
    if (!this.page) return null;

    try {
      return await this.page.evaluate(() => {
        const iframe = document.getElementById('site-iframe') as HTMLIFrameElement;
        if (iframe && iframe.contentWindow) {
          try {
            return iframe.contentWindow.location.href;
          } catch (e) {
            // Cross-origin restrictions - return the src attribute
            return iframe.src;
          }
        }
        return null;
      });
    } catch (error) {
      console.error('[Debug Wrapper] Error getting iframe URL:', error);
      return null;
    }
  }
}