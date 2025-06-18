import { NextRequest, NextResponse } from 'next/server';

// Store active recording sessions (in production, use a database)
const activeRecordings = new Map<string, any>();

export async function POST(request: NextRequest) {
  try {
    const { action, crawlId, startUrl } = await request.json();
    
    if (action === 'start') {
      if (!crawlId || !startUrl) {
        return NextResponse.json(
          { error: 'crawlId and startUrl are required' },
          { status: 400 }
        );
      }
      
      // Get the active crawler instance
      const activeCrawlers = (global as any).activeCrawlers;
      const crawler = activeCrawlers?.get(crawlId);
      
      if (!crawler) {
        return NextResponse.json(
          { error: 'Crawler not found or not active' },
          { status: 404 }
        );
      }
      
      // Start recording
      await crawler.startRecording(startUrl);
      
      return NextResponse.json({
        message: 'Recording started successfully',
        crawlId,
        startUrl
      });
      
    } else if (action === 'stop') {
      if (!crawlId) {
        return NextResponse.json(
          { error: 'crawlId is required' },
          { status: 400 }
        );
      }
      
      // Get the active crawler instance
      const activeCrawlers = (global as any).activeCrawlers;
      const crawler = activeCrawlers?.get(crawlId);
      
      if (!crawler) {
        return NextResponse.json(
          { error: 'Crawler not found or not active' },
          { status: 404 }
        );
      }
      
      // Stop recording
      const session = await crawler.stopRecording();
      
      return NextResponse.json({
        message: 'Recording stopped successfully',
        session: session
      });
      
    } else {
      return NextResponse.json(
        { error: 'Invalid action. Use "start" or "stop"' },
        { status: 400 }
      );
    }
    
  } catch (error) {
    console.error('Recording API error:', error);
    return NextResponse.json(
      { error: 'Failed to handle recording request' },
      { status: 500 }
    );
  }
}