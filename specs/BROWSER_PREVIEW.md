# Browser Preview Panel Feature

## Overview
The crawler now includes a real-time browser preview panel that shows the Playwright browser screen and visualizes all actions being performed during crawling.

## Features

### 🖥️ **Live Browser Preview**
- **Real-time screenshot streaming** from the Playwright browser
- **Screenshot updates every 3 seconds** during active crawling
- **Full-page screenshots** captured automatically
- **Responsive image display** that adapts to panel size

### 🎯 **Action Visualization**
- **Visual action overlays** on screenshots showing:
  - Click actions with precise pixel coordinates
  - Typing actions with element selectors
  - Scroll actions with scroll amounts
  - Navigation events
  - Hover actions
  - Screenshot captures

### 🎮 **Interactive Controls**
- **Maximize/Minimize** toggle for full-screen viewing
- **Download screenshot** button for saving current view
- **Toggle action overlays** to show/hide visual indicators
- **Action history** display in bottom panel

### 📊 **Action Tracking**
Real-time tracking of all browser actions:

#### Navigation Actions
```typescript
{
  type: 'navigate',
  url: 'https://example.com',
  timestamp: '2024-01-01T12:00:00Z'
}
```

#### Click Actions
```typescript
{
  type: 'click',
  url: 'https://example.com',
  position: { x: 300, y: 200 },
  element_selector: 'button:has-text("Login")',
  element_text: 'Login'
}
```

#### Type Actions
```typescript
{
  type: 'type',
  url: 'https://example.com',
  element_selector: 'input[name="username"]',
  input_text: 'user@example.com'
}
```

#### Scroll Actions
```typescript
{
  type: 'scroll',
  url: 'https://example.com',
  scroll_amount: 300
}
```

### 🎨 **Visual Indicators**

#### Color-Coded Action Types
- **Blue**: Click actions
- **Green**: Type actions  
- **Yellow**: Scroll actions
- **Purple**: Navigation
- **Pink**: Screenshots
- **Orange**: Hover actions
- **Gray**: Wait actions

#### Action Overlays
- **Animated ping effect** for recent actions
- **Precise positioning** based on element coordinates
- **Tooltips** showing action details on hover
- **Auto-fade** after 5 seconds

### 📱 **Layout Integration**

#### Four-Column Layout
1. **Configuration Panel** (1 column): Crawler settings and options
2. **Browser Preview** (2 columns): Live browser view with actions
3. **Status & Events** (1 column): Progress, current page, and event log

#### Responsive Design
- **Mobile-friendly** responsive grid layout
- **Expandable preview** for full-screen viewing
- **Collapsible panels** on smaller screens

### 🔧 **Technical Implementation**

#### Screenshot Streaming
- **Automatic capture** after each significant action
- **File-based storage** in `screenshots/` directory
- **API endpoint** `/api/screenshots/[filename]` for serving images
- **Memory management** - only stores latest 20 actions

#### Action Logging
- **Real-time tracking** of all Playwright actions
- **Position calculation** for click events using `boundingBox()`
- **Element identification** with CSS selectors
- **Privacy protection** - passwords masked as `••••••••`

#### Performance Optimization
- **Lazy screenshot updates** (3-second intervals)
- **Action history limiting** (20 most recent actions)
- **Efficient image caching** with 1-hour cache headers
- **Lightweight action objects** with minimal data

## Usage

### Automatic Operation
The browser preview works automatically when crawling starts:

1. **Crawl begins** → Browser preview activates
2. **Actions performed** → Visual overlays appear on screenshot
3. **Screenshots captured** → Image updates in real-time
4. **Crawl completes** → Final screenshot retained

### Manual Controls
- **Click maximize button** for full-screen browser view
- **Toggle action overlays** to focus on content
- **Download current screenshot** for offline analysis
- **View action history** in bottom panel

### Integration with Event Log
- **Synchronized display** - actions appear in both preview and event log
- **Cross-reference capability** - click events show in both panels
- **Detailed logging** - event log provides additional context

## Benefits

### 🔍 **Visual Debugging**
- **See exactly what the crawler is doing** in real-time
- **Identify UI interaction issues** immediately
- **Debug login flows** with visual confirmation
- **Spot element detection problems** quickly

### 📈 **User Experience**
- **Engaging visual feedback** during crawling
- **Professional dashboard appearance**
- **Real-time progress visualization**
- **Educational tool** for understanding web automation

### 🛠️ **Development & Testing**
- **Immediate feedback** on crawler behavior
- **Visual validation** of human-like actions
- **Screenshot documentation** of crawl sessions
- **Action replay capability** for debugging

### 🎯 **Monitoring & Analytics**
- **Action frequency analysis** from history
- **Element interaction patterns** visualization
- **Screenshot timeline** for process documentation
- **Performance metrics** through visual feedback

## Future Enhancements

- **Video recording** of entire crawl sessions
- **Action replay** functionality
- **Click heatmap** generation
- **WebSocket streaming** for real-time updates
- **Multi-browser support** with tab switching
- **Mobile device simulation** preview
- **Network request visualization** overlay