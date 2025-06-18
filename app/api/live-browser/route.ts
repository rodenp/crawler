import { NextRequest, NextResponse } from 'next/server';
import { LiveBrowserSession } from '@/lib/recorder/browser-session';

// Store active live browser sessions
const activeSessions = new Map<string, LiveBrowserSession>();

export async function POST(request: NextRequest) {
  try {
    const { action, startUrl, sessionId } = await request.json();
    
    if (action === 'start') {
      if (!startUrl) {
        return NextResponse.json(
          { error: 'startUrl is required' },
          { status: 400 }
        );
      }
      
      // Create new live browser session
      const browserSession = new LiveBrowserSession();
      const { sessionId: newSessionId, wsEndpoint } = await browserSession.startLiveSession(startUrl);
      
      // Store the session
      activeSessions.set(newSessionId, browserSession);
      
      return NextResponse.json({
        message: 'Live browser session started successfully',
        sessionId: newSessionId,
        wsEndpoint,
        debugPort: 9222, // Chrome DevTools port
        startUrl
      });
      
    } else if (action === 'stop') {
      if (!sessionId) {
        return NextResponse.json(
          { error: 'sessionId is required' },
          { status: 400 }
        );
      }
      
      const browserSession = activeSessions.get(sessionId);
      if (!browserSession) {
        return NextResponse.json(
          { error: 'Session not found' },
          { status: 404 }
        );
      }
      
      // Stop the session
      const recordingSession = await browserSession.stopLiveSession();
      activeSessions.delete(sessionId);
      
      return NextResponse.json({
        message: 'Live browser session stopped successfully',
        session: recordingSession
      });
      
    } else {
      return NextResponse.json(
        { error: 'Invalid action. Use "start" or "stop"' },
        { status: 400 }
      );
    }
    
  } catch (error) {
    console.error('Live browser API error:', error);
    return NextResponse.json(
      { error: 'Failed to handle browser session request' },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get('sessionId');
  
  if (!sessionId) {
    return NextResponse.json(
      { error: 'sessionId is required' },
      { status: 400 }
    );
  }
  
  const browserSession = activeSessions.get(sessionId);
  if (!browserSession) {
    return NextResponse.json(
      { error: 'Session not found' },
      { status: 404 }
    );
  }
  
  return NextResponse.json({
    isActive: browserSession.isSessionActive(),
    currentUrl: browserSession.getCurrentUrl(),
    session: browserSession.getRecordingSession(),
    debugPort: 9222
  });
}