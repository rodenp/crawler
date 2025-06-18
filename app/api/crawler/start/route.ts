import { NextRequest, NextResponse } from 'next/server';
import { CrawlerEngine } from '@/lib/crawler/crawler-engine';
import { CrawlConfig } from '@/lib/types/crawler';
import { getGlobalState, setBrowserSession } from '@/lib/shared/global-state';
import fs from 'fs/promises';
import path from 'path';

// Get the global state and make sure it's properly initialized
const activeCrawlers = getGlobalState();

export async function POST(request: NextRequest) {
  try {
    const config: CrawlConfig = await request.json();
    
    // Validate config
    if (!config.startUrl) {
      return NextResponse.json(
        { error: 'Start URL is required' },
        { status: 400 }
      );
    }
    
    // Handle manual recording mode differently
    if (config.mode === 'record') {
      const { LiveBrowserSession } = await import('@/lib/recorder/browser-session');
      const browserSession = new LiveBrowserSession();
      const { sessionId, wsEndpoint } = await browserSession.startLiveSession(config.startUrl);
      
      // Store browser session for status checks
      setBrowserSession(sessionId, browserSession);
      console.log(`[Crawler Start] Stored browser session with ID: ${sessionId}`);
      
      // Enable training mode if requested in config
      if (config.trainingMode) {
        console.log(`[Crawler Start] Enabling training mode for session: ${sessionId}`);
        browserSession.enableTrainingMode();
      }
      
      return NextResponse.json({
        crawlId: sessionId,
        message: 'Live browser session started successfully',
        mode: 'record',
        wsEndpoint,
        debugPort: 9222,
        trainingMode: config.trainingMode || false
      });
    }
    
    // Create crawler instance for crawl/scrape modes
    const crawler = new CrawlerEngine(config);
    const crawlId = crypto.randomUUID();
    
    // Store progress data for this crawl
    let currentProgress: any = null;
    crawler.setProgressCallback((progress) => {
      currentProgress = progress;
    });
    
    activeCrawlers.set(crawlId, crawler);
    (activeCrawlers as any).progressData = (activeCrawlers as any).progressData || new Map();
    (activeCrawlers as any).progressData.set(crawlId, () => currentProgress);
    
    // Start crawling in background
    crawler.start().then(async (result) => {
      // Save results to file
      const resultsDir = path.join(process.cwd(), 'crawl-results');
      const screenshotsDir = path.join(process.cwd(), 'screenshots');
      await fs.mkdir(resultsDir, { recursive: true });
      await fs.mkdir(screenshotsDir, { recursive: true });
      
      const filename = `crawl_${crawlId}_${Date.now()}.json`;
      const filepath = path.join(resultsDir, filename);
      
      await fs.writeFile(filepath, JSON.stringify(result, null, 2));
      
      // Clean up
      activeCrawlers.delete(crawlId);
      (activeCrawlers as any).progressData?.delete(crawlId);
    }).catch((error) => {
      console.error('Crawl error:', error);
      activeCrawlers.delete(crawlId);
      (activeCrawlers as any).progressData?.delete(crawlId);
    });
    
    return NextResponse.json({
      crawlId,
      message: 'Crawl started successfully'
    });
    
  } catch (error) {
    console.error('API error:', error);
    return NextResponse.json(
      { error: 'Failed to start crawl' },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  const crawlId = request.nextUrl.searchParams.get('crawlId');
  
  if (!crawlId) {
    return NextResponse.json(
      { error: 'Crawl ID is required' },
      { status: 400 }
    );
  }
  
  // Check if this is a live browser session
  const browserSession = (activeCrawlers as any).browserSessions?.get(crawlId);
  if (browserSession) {
    const session = browserSession.getRecordingSession();
    return NextResponse.json({
      status: browserSession.isSessionActive() ? 'recording' : 'completed',
      message: browserSession.isSessionActive() ? 'Recording in progress' : 'Recording completed',
      progress: {
        current_url: browserSession.getCurrentUrl(),
        pages_discovered: session?.actions.length || 0,
        pages_crawled: session?.screenshots.length || 0,
        success_rate: 100,
        elapsed_time: session ? new Date().getTime() - new Date(session.start_time).getTime() : 0,
        status: browserSession.isSessionActive() ? 'recording' as const : 'completed' as const,
        mode: 'record',
        session: session
      }
    });
  }
  
  const crawler = activeCrawlers.get(crawlId);
  
  if (!crawler) {
    // Check if results file exists
    try {
      const resultsDir = path.join(process.cwd(), 'crawl-results');
      const files = await fs.readdir(resultsDir);
      const resultFile = files.find(f => f.includes(crawlId));
      
      if (resultFile) {
        const filepath = path.join(resultsDir, resultFile);
        const content = await fs.readFile(filepath, 'utf-8');
        return NextResponse.json({
          status: 'completed',
          result: JSON.parse(content)
        });
      }
    } catch (error) {
      console.error('Error reading results:', error);
    }
    
    return NextResponse.json(
      { error: 'Crawl not found' },
      { status: 404 }
    );
  }
  
  // Get current progress
  const progressData = (activeCrawlers as any).progressData?.get(crawlId);
  const currentProgress = progressData ? progressData() : null;
  
  return NextResponse.json({
    status: 'running',
    message: 'Crawl is still in progress',
    progress: currentProgress
  });
}

export async function DELETE(request: NextRequest) {
  const crawlId = request.nextUrl.searchParams.get('crawlId');
  
  if (!crawlId) {
    return NextResponse.json(
      { error: 'Crawl ID is required' },
      { status: 400 }
    );
  }
  
  // Check if this is a live browser session
  const browserSession = (activeCrawlers as any).browserSessions?.get(crawlId);
  if (browserSession) {
    try {
      const session = await browserSession.stopLiveSession();
      (activeCrawlers as any).browserSessions.delete(crawlId);
      return NextResponse.json({
        message: 'Live browser session stop requested successfully',
        session: session
      });
    } catch (error) {
      console.error('Error stopping browser session:', error);
      return NextResponse.json(
        { error: 'Failed to stop browser session' },
        { status: 500 }
      );
    }
  }
  
  const crawler = activeCrawlers.get(crawlId);
  
  if (!crawler) {
    return NextResponse.json(
      { error: 'Crawl not found or already completed' },
      { status: 404 }
    );
  }
  
  try {
    crawler.stop();
    return NextResponse.json({
      message: 'Crawl stop requested successfully'
    });
  } catch (error) {
    console.error('Error stopping crawl:', error);
    return NextResponse.json(
      { error: 'Failed to stop crawl' },
      { status: 500 }
    );
  }
}