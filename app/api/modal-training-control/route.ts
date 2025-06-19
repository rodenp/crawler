import { NextRequest, NextResponse } from 'next/server';
import { getBrowserSession, getBrowserSessions } from '@/lib/shared/global-state';

export async function POST(request: NextRequest) {
  try {
    // Check content-type header
    const contentType = request.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      console.warn('[Modal Training API] Invalid content-type:', contentType);
    }
    
    // Handle empty request body
    let body;
    try {
      const text = await request.text();
      console.log('[Modal Training API] Raw request body:', text);
      
      if (!text || text.trim() === '') {
        console.error('[Modal Training API] Empty request body received');
        return NextResponse.json(
          { error: 'Empty request body' },
          { status: 400 }
        );
      }
      
      body = JSON.parse(text);
    } catch (jsonError) {
      console.error('[Modal Training API] JSON parsing error:', jsonError);
      return NextResponse.json(
        { error: 'Invalid JSON in request body', details: jsonError instanceof Error ? jsonError.message : 'Unknown error' },
        { status: 400 }
      );
    }
    
    const { sessionId, action } = body;
    
    console.log(`[Modal Training API] Received action: ${action} for session: ${sessionId}`);
    
    if (!sessionId) {
      return NextResponse.json(
        { error: 'Session ID is required' },
        { status: 400 }
      );
    }

    // Get browser session using shared state management
    const browserSessions = getBrowserSessions();
    console.log(`[Modal Training API] Looking for session: ${sessionId}`);
    console.log(`[Modal Training API] Available sessions: ${Array.from(browserSessions.keys())}`);
    const browserSession = getBrowserSession(sessionId);
    
    if (!browserSession) {
      return NextResponse.json(
        { 
          error: `Browser session '${sessionId}' not found.`, 
          availableSessions: Array.from(browserSessions.keys()),
          debug: 'Please check if the recording session is still active.'
        },
        { status: 404 }
      );
    }

    switch (action) {
      case 'enable_training':
        browserSession.enableTrainingMode();
        return NextResponse.json({
          success: true,
          message: 'Training mode enabled',
          domain: browserSession.getCurrentDomain(),
          trainingMode: true
        });

      case 'disable_training':
        browserSession.disableTrainingMode();
        return NextResponse.json({
          success: true,
          message: 'Training mode disabled',
          domain: browserSession.getCurrentDomain(),
          trainingMode: false
        });

      case 'get_status':
        const isTraining = browserSession.isInTrainingMode();
        const domain = browserSession.getCurrentDomain();
        const rules = await browserSession.getSiteParsingRules();
        
        return NextResponse.json({
          success: true,
          trainingMode: isTraining,
          domain: domain,
          hasRules: !!rules,
          rulesCount: rules?.rules?.length || 0,
          lastUpdated: rules?.lastUpdated || null
        });

      case 'get_rules':
        const parsingRules = await browserSession.getSiteParsingRules();
        return NextResponse.json({
          success: true,
          domain: browserSession.getCurrentDomain(),
          rules: parsingRules
        });

      default:
        return NextResponse.json(
          { error: 'Invalid action. Use: enable_training, disable_training, get_status, or get_rules' },
          { status: 400 }
        );
    }

  } catch (error) {
    console.error('Modal training control error:', error);
    return NextResponse.json(
      { error: 'Failed to control modal training', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId');
    
    if (!sessionId) {
      return NextResponse.json(
        { error: 'Session ID is required' },
        { status: 400 }
      );
    }

    // Get browser session using shared state management
    const browserSessions = getBrowserSessions();
    console.log(`[Modal Training API] Looking for session: ${sessionId}`);
    console.log(`[Modal Training API] Available sessions: ${Array.from(browserSessions.keys())}`);
    const browserSession = getBrowserSession(sessionId);
    
    if (!browserSession) {
      return NextResponse.json(
        { 
          error: `Browser session '${sessionId}' not found.`, 
          availableSessions: Array.from(browserSessions.keys()),
          debug: 'Please check if the recording session is still active.'
        },
        { status: 404 }
      );
    }

    const isTraining = browserSession.isInTrainingMode();
    const domain = browserSession.getCurrentDomain();
    const rules = await browserSession.getSiteParsingRules();
    
    return NextResponse.json({
      success: true,
      trainingMode: isTraining,
      domain: domain,
      hasRules: !!rules,
      rulesCount: rules?.rules?.length || 0,
      lastUpdated: rules?.lastUpdated || null,
      rules: rules
    });

  } catch (error) {
    console.error('Modal training control error:', error);
    return NextResponse.json(
      { error: 'Failed to get modal training status', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}