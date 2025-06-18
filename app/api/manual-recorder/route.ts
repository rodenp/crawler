import { NextRequest, NextResponse } from 'next/server';
import { ManualRecorder } from '@/lib/recorder/manual-recorder';

// Store active manual recording sessions
const activeRecorders = new Map<string, ManualRecorder>();

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
      
      // Create new manual recorder
      const recorder = new ManualRecorder();
      const newSessionId = await recorder.startRecording(startUrl);
      
      // Store the recorder
      activeRecorders.set(newSessionId, recorder);
      
      return NextResponse.json({
        message: 'Manual recording started successfully',
        sessionId: newSessionId,
        startUrl
      });
      
    } else if (action === 'stop') {
      if (!sessionId) {
        return NextResponse.json(
          { error: 'sessionId is required' },
          { status: 400 }
        );
      }
      
      const recorder = activeRecorders.get(sessionId);
      if (!recorder) {
        return NextResponse.json(
          { error: 'Recording session not found' },
          { status: 404 }
        );
      }
      
      // Stop recording
      const session = await recorder.stopRecording();
      activeRecorders.delete(sessionId);
      
      return NextResponse.json({
        message: 'Recording stopped successfully',
        session: session
      });
      
    } else if (action === 'status') {
      if (!sessionId) {
        return NextResponse.json(
          { error: 'sessionId is required' },
          { status: 400 }
        );
      }
      
      const recorder = activeRecorders.get(sessionId);
      if (!recorder) {
        return NextResponse.json(
          { error: 'Recording session not found' },
          { status: 404 }
        );
      }
      
      return NextResponse.json({
        isActive: recorder.isRecordingActive(),
        currentUrl: recorder.getCurrentUrl(),
        session: recorder.getRecordingSession()
      });
      
    } else {
      return NextResponse.json(
        { error: 'Invalid action. Use "start", "stop", or "status"' },
        { status: 400 }
      );
    }
    
  } catch (error) {
    console.error('Manual recording API error:', error);
    return NextResponse.json(
      { error: 'Failed to handle recording request' },
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
  
  const recorder = activeRecorders.get(sessionId);
  if (!recorder) {
    return NextResponse.json(
      { error: 'Recording session not found' },
      { status: 404 }
    );
  }
  
  return NextResponse.json({
    isActive: recorder.isRecordingActive(),
    currentUrl: recorder.getCurrentUrl(),
    session: recorder.getRecordingSession()
  });
}