# Advanced Web Crawler & Scraper with Playwright

Create a sophisticated web crawling and scraping application using Playwright with the following comprehensive features:

## Core Requirements

### 1. Technology Stack

- **Backend**: Node.js with Playwright for browser automation
- **Frontend**: React.js with a clean, intuitive interface
- **Database**: JSON file storage for crawl results
- **Browser**: Chromium with stealth mode to avoid detection

### 2. Browser Automation Features

**DOM Event Monitoring**: Listen for and respond to dynamic content changes, AJAX requests, and DOM mutations

**Automatic Login Handling**:
- Detect login forms automatically
- Support multiple authentication methods (username/password, OAuth, 2FA)
- Store and reuse session cookies
- Handle session timeouts and re-authentication

**CAPTCHA Solving**:
- Integrate with CAPTCHA solving services (2captcha, Anti-Captcha)
- Support reCAPTCHA v2, v3, hCaptcha, and image-based CAPTCHAs
- Implement retry logic for failed CAPTCHA attempts

**Human-like Interactions**:
- Random delays between actions (200ms - 2000ms)
- Simulate natural mouse movements and typing patterns
- Vary typing speed with occasional typos and corrections
- Random scroll patterns and page interactions
- Simulate human reading time before proceeding

### 3. Frontend Interface

Create a user-friendly React frontend with:

**URL Input**: Text field for starting URL with validation

**Crawl Depth Control**: Slider/input for maximum crawl depth (1-10)

**Advanced Options Panel**:
- Login credentials input (username/password)
- Custom headers configuration
- Rate limiting settings (requests per minute)
- File type filters (images, documents, etc.)
- Domain restrictions (stay within domain, include subdomains)

**Real-time Progress Display**:
- Current page being crawled
- Pages discovered vs. pages crawled
- Success/error rates
- Time elapsed and estimated completion

**Results Visualization**:
- Interactive site map showing navigation paths
- Tree view of discovered URLs
- Screenshot gallery with thumbnails
- Error log with details

### 4. Crawling Logic

Implement intelligent crawling with:

- **Link Discovery**: Extract all internal links, handle relative URLs, detect pagination
- **Selector Tracking**: Capture the exact CSS selector and element details for each discovered link
- **Link Relationship Mapping**: Record the relationship between source and target pages with element context
- **Duplicate Detection**: URL normalization and deduplication
- **Respect Robots.txt**: Parse and follow robots.txt rules
- **Rate Limiting**: Configurable delays between requests
- **Error Handling**: Retry failed requests, handle timeouts gracefully
- **Session Management**: Maintain cookies and session state across pages

### 5. Data Extraction & Output

Generate comprehensive JSON output with this structure:

```json
{
  "crawl_metadata": {
    "start_url": "https://example.com",
    "start_time": "2025-06-15T10:30:00Z",
    "end_time": "2025-06-15T11:45:00Z",
    "total_pages": 150,
    "successful_crawls": 145,
    "failed_crawls": 5,
    "max_depth": 3,
    "crawl_id": "uuid-string"
  },
  "site_structure": {
    "domain": "example.com",
    "navigation_paths": [
      {
        "path": "/",
        "depth": 0,
        "parent": null,
        "children": ["/about", "/products", "/contact"]
      }
    ],
    "link_relationships": [
      {
        "from": "https://example.com",
        "to": "https://example.com/about",
        "label": "About Us",
        "selector": "a.nav-link.about",
        "element_type": "anchor",
        "position": {"x": 150, "y": 75},
        "discovery_timestamp": "2025-06-15T10:32:10Z"
      },
      {
        "from": "https://example.com",
        "to": "https://example.com/contact",
        "label": "Contact",
        "selector": "button#contact",
        "element_type": "button",
        "position": {"x": 300, "y": 75},
        "discovery_timestamp": "2025-06-15T10:32:10Z"
      },
      {
        "from": "https://example.com/about",
        "to": "https://example.com/team",
        "label": "Meet Our Team",
        "selector": "a[href='/team']",
        "element_type": "anchor",
        "position": {"x": 200, "y": 450},
        "discovery_timestamp": "2025-06-15T10:33:22Z"
      }
    ],
    "sitemap": "url_hierarchy_tree"
  },
  "pages": [
    {
      "url": "https://example.com/page",
      "title": "Page Title",
      "meta_description": "Page description",
      "status_code": 200,
      "depth": 2,
      "parent_url": "https://example.com/parent",
      "discovery_path": ["https://example.com", "https://example.com/parent", "https://example.com/page"],
      "discovered_via": {
        "selector": "a.nav-link.products",
        "link_text": "Our Products",
        "element_type": "anchor"
      },
      "crawl_timestamp": "2025-06-15T10:35:22Z",
      "load_time": 1250,
      "content": {
        "text_content": "extracted_text",
        "headings": ["h1", "h2", "h3"],
        "links": ["internal_links", "external_links"],
        "images": [{"src": "url", "alt": "text"}],
        "forms": [{"action": "url", "method": "post", "fields": ["field_names"]}]
      },
      "technical_data": {
        "response_headers": {},
        "page_size": 45000,
        "dom_elements_count": 234,
        "javascript_errors": [],
        "console_logs": []
      },
      "screenshot": {
        "filename": "page_screenshot.png",
        "full_page": true,
        "viewport": {"width": 1920, "height": 1080}
      }
    }
  ],
  "assets": {
    "stylesheets": ["css_files"],
    "scripts": ["js_files"],
    "images": ["image_files"],
    "documents": ["pdf_word_files"]
  },
  "errors": [
    {
      "url": "failed_url",
      "error_type": "timeout|404|javascript_error",
      "error_message": "detailed_error",
      "timestamp": "2025-06-15T10:40:15Z",
      "retry_attempts": 3
    }
  ]
}
```

### 6. Visual Navigation Mapping

Create an interactive visualization showing:

- **Site Hierarchy**: Tree structure of discovered pages
- **Navigation Paths**: Visual representation of how each page was discovered
- **Depth Indicators**: Color-coding or sizing based on crawl depth
- **Status Indicators**: Success/failure/warning states for each page
- **Link Relationships Export**: Generate the specific link relationship format for navigation analysis
- **Graph Visualization**: Create interactive network graphs showing page connections via actual HTML elements

### 7. Screenshot Management

- **Full-page Screenshots**: Capture entire page content, not just viewport
- **Thumbnail Generation**: Create smaller preview images
- **Organized Storage**: Store screenshots with meaningful filenames
- **Mobile/Desktop Views**: Option to capture both responsive views
- **Before/After Login**: Capture changes after authentication

### 8. Advanced Features

- **JavaScript Execution**: Wait for dynamic content to load
- **Infinite Scroll Handling**: Automatically load all content
- **PDF/Document Processing**: Extract text from downloadable files
- **Multi-language Support**: Handle international characters and RTL text
- **Performance Monitoring**: Track page load times and performance metrics
- **Export Options**: CSV, XML, and Excel export formats

### 9. Security & Ethics

- **Respect Rate Limits**: Configurable delays and concurrent request limits
- **User-Agent Rotation**: Rotate user agents to avoid detection
- **Proxy Support**: Optional proxy rotation for large-scale crawling
- **Data Privacy**: Option to exclude sensitive form fields from output
- **Terms of Service Compliance**: Warning system for restricted content

### 10. Error Handling & Monitoring

- **Comprehensive Logging**: Detailed logs for debugging and monitoring
- **Retry Mechanisms**: Intelligent retry logic with exponential backoff
- **Health Checks**: Monitor crawler performance and resource usage
- **Graceful Shutdown**: Proper cleanup and state saving on interruption
- **Resume Capability**: Ability to resume interrupted crawls

## Implementation Guidelines

- Use TypeScript for better code quality and type safety
- Implement proper error boundaries in React components
- Use worker threads for CPU-intensive tasks
- Implement caching for frequently accessed data
- Add comprehensive unit tests for core functionality
- Use environment variables for configuration
- Implement proper logging with different log levels
- Add performance monitoring and memory usage tracking

## Deliverables

- Complete Node.js backend with Playwright integration
- React frontend with all specified features
- Comprehensive documentation and setup instructions
- Example configuration files and environment setup
- Unit tests with good coverage
- Docker configuration for easy deployment
- API documentation for extending functionality

Build this as a production-ready application with proper error handling, logging, and user experience considerations. The crawler should be robust enough to handle various website structures while being respectful of server resources and website terms of service.