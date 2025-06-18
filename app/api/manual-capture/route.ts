import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const { sessionId, boundingBox } = await request.json();
    
    if (!sessionId) {
      return NextResponse.json(
        { error: 'Session ID is required' },
        { status: 400 }
      );
    }

    // Get browser session
    const activeCrawlers = (global as any).activeCrawlers;
    const browserSessions = activeCrawlers?.browserSessions;
    if (!browserSessions) {
      return NextResponse.json(
        { error: 'No active browser sessions' },
        { status: 404 }
      );
    }

    const browserSession = browserSessions.get(sessionId);
    if (!browserSession) {
      return NextResponse.json(
        { error: 'Browser session not found' },
        { status: 404 }
      );
    }

    // Perform manual capture
    const result = await browserSession.manualCapture(boundingBox);

    return NextResponse.json({
      success: true,
      filename: result.filename,
      message: boundingBox 
        ? `Captured area ${boundingBox.width}x${boundingBox.height}` 
        : 'Captured viewport'
    });

  } catch (error) {
    console.error('Manual capture error:', error);
    return NextResponse.json(
      { error: 'Failed to capture screenshot', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}