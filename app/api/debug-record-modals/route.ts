import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const { crawlId } = await request.json();
    
    if (!crawlId) {
      return NextResponse.json(
        { error: 'Crawl ID is required' },
        { status: 400 }
      );
    }

    // Get the active crawler instance that handles recording
    const activeCrawlers = (global as any).activeCrawlers;
    const crawler = activeCrawlers?.get(crawlId);
    
    if (!crawler) {
      return NextResponse.json(
        { error: 'Crawler/recording session not found' },
        { status: 404 }
      );
    }

    // Try to get the browser session if it exists
    let debugResult = null;
    
    // Check if crawler has a browser session (for record mode)
    if (crawler.browserSession) {
      console.log('[Debug] Found browser session, analyzing modals...');
      debugResult = await crawler.browserSession.debugCurrentModals();
      
      // Also trigger manual modal detection
      await crawler.browserSession.triggerModalDetection();
    } else {
      console.log('[Debug] No browser session found on crawler');
    }

    return NextResponse.json({
      success: true,
      modalAnalysis: debugResult,
      hasBrowserSession: !!crawler.browserSession,
      message: debugResult 
        ? `Debug completed! Found ${debugResult.candidates?.length || 0} modal candidates.`
        : 'No browser session found for debugging'
    });

  } catch (error) {
    console.error('Debug record modals error:', error);
    return NextResponse.json(
      { error: 'Failed to debug modals', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}