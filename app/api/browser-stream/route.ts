import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get('sessionId');
  
  if (!sessionId) {
    return NextResponse.json(
      { error: 'sessionId is required' },
      { status: 400 }
    );
  }
  
  // Get the browser session
  const activeCrawlers = (global as any).activeCrawlers;
  const browserSession = activeCrawlers?.browserSessions?.get(sessionId);
  if (!browserSession) {
    return NextResponse.json(
      { error: 'Session not found' },
      { status: 404 }
    );
  }
  
  try {
    const page = browserSession.getPage();
    if (!page) {
      return NextResponse.json(
        { error: 'No active page' },
        { status: 404 }
      );
    }
    
    // Take a full page screenshot of current state
    const screenshot = await page.screenshot({
      type: 'jpeg',
      quality: 70,
      fullPage: true // Capture entire page
    });
    
    // Return as image
    return new NextResponse(screenshot, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    });
    
  } catch (error) {
    console.error('Error capturing browser stream:', error);
    return NextResponse.json(
      { error: 'Failed to capture browser stream' },
      { status: 500 }
    );
  }
}