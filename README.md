# Advanced Web Crawler

A sophisticated web crawling and scraping application built with Next.js and Playwright.

## Features

- 🚀 **Advanced Browser Automation**: Powered by Playwright with stealth mode
- 🔐 **Automatic Login Handling**: Detects and handles login forms
- 🤖 **Human-like Behavior**: Random delays, mouse movements, and typing patterns
- 📊 **Real-time Progress Tracking**: Live updates during crawling
- 🗺️ **Visual Site Mapping**: Interactive visualization of discovered pages
- 📸 **Screenshot Management**: Full-page screenshots of crawled pages
- 🎯 **Smart Link Discovery**: Tracks CSS selectors and element relationships
- ⚡ **Rate Limiting**: Configurable delays to respect server resources
- 📁 **JSON Export**: Comprehensive crawl results in structured format

## Quick Start

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Run the development server:**
   ```bash
   npm run dev
   ```

3. **Open your browser:**
   Navigate to [http://localhost:3000](http://localhost:3000)

## Usage

1. Enter the starting URL you want to crawl
2. Adjust the crawl depth (1-10 levels)
3. Configure advanced options if needed:
   - Login credentials for authenticated sites
   - Rate limiting settings
   - Domain restrictions
4. Click "Start Crawling" and monitor progress in real-time
5. Download results as JSON when complete

## Project Structure

```
├── app/
│   ├── api/crawler/    # API routes for crawler operations
│   └── page.tsx        # Main UI page
├── components/
│   ├── crawler/        # Crawler-specific components
│   └── ui/            # Reusable UI components
├── lib/
│   ├── crawler/       # Core crawler logic
│   ├── types/         # TypeScript type definitions
│   └── utils.ts       # Utility functions
└── crawl-results/     # Stored crawl results (auto-created)
```

## API Endpoints

- `POST /api/crawler/start` - Start a new crawl
- `GET /api/crawler/start?crawlId={id}` - Check crawl status

## Configuration

The crawler supports various configuration options:

```typescript
{
  startUrl: string;              // URL to start crawling from
  maxDepth: number;              // Maximum crawl depth (1-10)
  rateLimit: number;             // Requests per minute
  loginCredentials?: {           // Optional login credentials
    username: string;
    password: string;
  };
  domainRestrictions?: {         // Domain crawling rules
    stayWithinDomain: boolean;
    includeSubdomains: boolean;
  };
}
```

## Output Format

The crawler generates comprehensive JSON output including:

- Crawl metadata (duration, success rate, etc.)
- Site structure with navigation paths
- Link relationships with CSS selectors
- Page content and technical data
- Screenshots information
- Error logs

## Development

```bash
# Run development server
npm run dev

# Build for production
npm run build

# Start production server
npm start

# Run linting
npm run lint
```

## Requirements

- Node.js 18+ 
- Modern browser for UI
- Sufficient disk space for screenshots

## Notes

- Playwright browsers are automatically installed via postinstall script
- Screenshots are stored in the `screenshots/` directory
- Crawl results are saved in `crawl-results/` as JSON files
- The crawler respects robots.txt by default
- Rate limiting prevents overwhelming target servers

## Future Enhancements

- WebSocket support for real-time updates
- CAPTCHA solving integration
- Proxy rotation support
- Export to CSV/Excel formats
- Visual site map generation
- Docker containerization
