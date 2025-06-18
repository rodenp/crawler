export interface CrawlConfig {
  startUrl: string;
  maxDepth: number;
  rateLimit: number;
  mode: 'crawl' | 'scrape' | 'record'; // New: record mode for manual navigation
  sampleMode?: boolean; // New: only retrieve one item from lists
  followLinkTags?: string[]; // New: which link tags to follow (e.g., ['a', 'button'])
  trainingMode?: boolean; // New: enable training mode for record sessions
  loginCredentials?: {
    username: string;
    password: string;
  };
  customHeaders?: Record<string, string>;
  fileTypeFilters?: string[];
  domainRestrictions?: {
    stayWithinDomain: boolean;
    includeSubdomains: boolean;
  };
  captchaSolving?: {
    enabled: boolean;
    service?: '2captcha' | 'anti-captcha';
    apiKey?: string;
  };
}

export interface LinkRelationship {
  from: string;
  to: string;
  label: string;
  selector: string;
  element_type: string;
  position: { x: number; y: number };
  discovery_timestamp: string;
}

export interface PageData {
  url: string;
  title: string;
  meta_description: string;
  status_code: number;
  depth: number;
  parent_url: string | null;
  discovery_path: string[];
  discovered_via: {
    selector: string;
    link_text: string;
    element_type: string;
  } | null;
  crawl_timestamp: string;
  load_time: number;
  content: {
    text_content: string;
    headings: string[];
    links: { internal: string[]; external: string[] };
    images: Array<{ src: string; alt: string }>;
    forms: Array<{
      action: string;
      method: string;
      fields: string[];
    }>;
    clickable_elements: Array<{
      index: number;
      tagName: string;
      textContent: string;
      innerText: string;
      className: string;
      id: string;
      href: string;
      isVisible: boolean;
      hasLogInText: boolean;
      hasSkoolClass: boolean;
    }>;
  };
  technical_data: {
    response_headers: Record<string, string>;
    page_size: number;
    dom_elements_count: number;
    javascript_errors: string[];
    console_logs: string[];
  };
  screenshot?: {
    filename: string;
    full_page: boolean;
    viewport: { width: number; height: number };
  };
}

export interface CrawlError {
  url: string;
  error_type: 'timeout' | '404' | 'javascript_error' | 'other';
  error_message: string;
  timestamp: string;
  retry_attempts: number;
}

export interface CrawlMetadata {
  start_url: string;
  start_time: string;
  end_time?: string;
  total_pages: number;
  successful_crawls: number;
  failed_crawls: number;
  max_depth: number;
  crawl_id: string;
}

export interface CrawlResult {
  crawl_metadata: CrawlMetadata;
  site_structure: {
    domain: string;
    navigation_paths: Array<{
      path: string;
      depth: number;
      parent: string | null;
      children: string[];
    }>;
    link_relationships: LinkRelationship[];
    sitemap: any;
  };
  pages: PageData[];
  assets: {
    stylesheets: string[];
    scripts: string[];
    images: string[];
    documents: string[];
  };
  errors: CrawlError[];
}

export interface CrawlProgress {
  current_url: string;
  pages_discovered: number;
  pages_crawled: number;
  success_rate: number;
  elapsed_time: number;
  estimated_completion?: number;
  status: 'idle' | 'crawling' | 'completed' | 'error' | 'recording';
  events?: CrawlEvent[]; // New: event log
  browser_actions?: BrowserAction[]; // New: browser actions for preview
  latest_screenshot?: string; // New: latest screenshot for browser preview
  session?: RecordingSession; // New: recording session for record mode
}

// New: Browser action for preview
export interface BrowserAction {
  id: string;
  timestamp: string;
  type: 'click' | 'type' | 'scroll' | 'navigate' | 'screenshot' | 'hover' | 'wait';
  url: string;
  position?: { x: number; y: number };
  element_selector?: string;
  element_text?: string;
  input_text?: string;
  scroll_amount?: number;
}

// New: Discovered link information
export interface DiscoveredLink {
  href: string;
  text: string;
  title?: string;
  element_type: string;
  selector: string;
  position?: { x: number; y: number };
  is_internal: boolean;
  is_button: boolean;
}

// New: Recorded user action for manual navigation
export interface RecordedAction {
  id: string;
  timestamp: string;
  type: 'navigation' | 'click' | 'type' | 'scroll' | 'keydown' | 'keyup' | 'mousemove' | 'manual_capture' | 'modal_interaction' | 'modal_content_change' | 'modal_tracking_start' | 'modal_training';
  from_url: string;
  to_url: string;
  actions: {
    action_description: string;
    screenshot?: string;
  }[];
  position?: { x: number; y: number };
  element_selector?: string;
  element_text?: string;
  screenshot_before?: string;
  screenshot_after?: string;
  element_id?: string;
  element_type?: string;
  element_name?: string;
  element_placeholder?: string;
  element_href?: string;
  input_text?: string;
  key?: string;
  scroll_delta?: { x: number; y: number };
  discovered_links?: DiscoveredLink[];
  capture_details?: {
    timestamp: string;
    filename: string;
    capture_type: 'area' | 'viewport';
    dimensions: {
      x?: number;
      y?: number;
      width: number;
      height: number;
    };
    page_url: string;
    page_title: string;
  };
}

// New: Modal state change
export interface ModalStateChange {
  timestamp: string;
  triggered_by: {
    action_type: string;
    action_description: string;
    element_selector?: string;
    element_text?: string;
  };
  change_description: string;
  screenshot: string;
  content_diff?: string;
}

// New: Modal/Popup detection
export interface DetectedModal {
  id: string;
  timestamp: string;
  triggered_by: {
    action_type: string;
    action_description: string;
    element_selector?: string;
    element_text?: string;
  };
  modal_selector?: string;
  modal_content?: string;
  screenshot: string;
  dimensions?: {
    width: number;
    height: number;
    top: number;
    left: number;
  };
  state_changes?: ModalStateChange[];
}

// New: Recording session
export interface RecordingSession {
  id: string;
  start_time: string;
  end_time?: string;
  start_url: string;
  actions: RecordedAction[];
  screenshots: string[];
  modals?: DetectedModal[];
}

// New: Event logging for UI
export interface CrawlEvent {
  id: string;
  timestamp: string;
  type: 'navigation' | 'dom_detection' | 'login' | 'captcha' | 'screenshot' | 'error' | 'action';
  url: string;
  message: string;
  details?: {
    element_selector?: string;
    element_type?: string;
    element_text?: string;
    element_text_lower?: string;
    element_inner_text?: string;
    element_all_child_text?: string;
    element_class?: string;
    element_id?: string;
    element_href?: string;
    is_visible?: boolean;
    combined_text?: string;
    matched_text?: string;
    matched_in?: string;
    matched_pattern?: string;
    has_login_text?: boolean;
    has_skool_class?: boolean;
    form_fields?: string[];
    screenshot_path?: string;
    error_details?: string;
    dom_elements_found?: number;
    links_discovered?: number;
  };
}