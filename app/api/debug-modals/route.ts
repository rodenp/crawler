import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const { sessionId } = await request.json();
    
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

    // Run debug analysis
    const modalAnalysis = await browserSession.debugCurrentModals();
    const fixedElements = await browserSession.debugFixedElements();
    
    // Also trigger manual modal detection
    await browserSession.triggerModalDetection();

    return NextResponse.json({
      success: true,
      modalAnalysis,
      fixedElements,
      message: 'Debug analysis completed'
    });

  } catch (error) {
    console.error('Debug modals error:', error);
    return NextResponse.json(
      { error: 'Failed to debug modals', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}