'use client';

import { useEffect, useRef, useState } from 'react';
import { RecordingSession } from '@/lib/types/crawler';
import { Monitor, Circle, Square, Camera, Clock, Crop } from 'lucide-react';

interface LiveBrowserSessionProps {
  sessionId: string | null;
  isActive: boolean;
  onSessionData?: (session: RecordingSession) => void;
}

export function LiveBrowserSession({ sessionId, isActive, onSessionData }: LiveBrowserSessionProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [session, setSession] = useState<RecordingSession | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [debugPort, setDebugPort] = useState<number | null>(null);
  const [streamKey, setStreamKey] = useState(Date.now());
  
  // Manual capture state
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionStart, setSelectionStart] = useState<{ x: number; y: number } | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<{ x: number; y: number } | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);

  useEffect(() => {
    if (!sessionId || !isActive) {
      setIsConnected(false);
      return;
    }

    // Poll for session data
    const pollSession = async () => {
      try {
        const response = await fetch(`/api/live-browser?sessionId=${sessionId}`);
        if (response.ok) {
          const data = await response.json();
          setSession(data.session);
          setDebugPort(data.debugPort);
          setIsConnected(true);
          
          if (onSessionData && data.session) {
            onSessionData(data.session);
          }
        }
      } catch (error) {
        console.error('Error polling session:', error);
        setIsConnected(false);
      }
    };

    // Initial poll
    pollSession();
    
    // Set up polling interval
    const interval = setInterval(pollSession, 1000);
    
    // Set up stream refresh
    const streamInterval = setInterval(() => {
      if (isActive && isConnected) {
        setStreamKey(Date.now());
      }
    }, 500); // Refresh every 500ms for smoother streaming
    
    return () => {
      clearInterval(interval);
      clearInterval(streamInterval);
    };
  }, [sessionId, isActive, onSessionData, isConnected]);

  // Calculate elapsed time
  const elapsedTime = session 
    ? (session.end_time 
        ? new Date(session.end_time).getTime() - new Date(session.start_time).getTime()
        : new Date().getTime() - new Date(session.start_time).getTime())
    : 0;

  const formatTime = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  // Manual capture functions
  const handleManualCapture = async (boundingBox?: { x: number; y: number; width: number; height: number }) => {
    if (!sessionId || isCapturing) return;
    
    setIsCapturing(true);
    try {
      const response = await fetch('/api/manual-capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, boundingBox }),
      });
      
      if (response.ok) {
        const data = await response.json();
        console.log('Manual capture successful:', data.filename);
        // Refresh session data to show new screenshot
        setTimeout(() => setStreamKey(Date.now()), 500);
      } else {
        console.error('Manual capture failed');
      }
    } catch (error) {
      console.error('Manual capture error:', error);
    }
    setIsCapturing(false);
  };

  const startSelection = () => {
    setIsSelecting(true);
    setSelectionStart(null);
    setSelectionEnd(null);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!isSelecting || !imgRef.current) return;
    
    const rect = imgRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    setSelectionStart({ x, y });
    setSelectionEnd({ x, y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isSelecting || !selectionStart || !imgRef.current) return;
    
    const rect = imgRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    setSelectionEnd({ x, y });
  };

  const handleMouseUp = async (e: React.MouseEvent) => {
    if (!isSelecting || !selectionStart || !selectionEnd || !imgRef.current) return;
    
    const rect = imgRef.current.getBoundingClientRect();
    const imgElement = imgRef.current;
    
    // Calculate actual image coordinates (accounting for scaling)
    const scaleX = imgElement.naturalWidth / imgElement.clientWidth;
    const scaleY = imgElement.naturalHeight / imgElement.clientHeight;
    
    const boundingBox = {
      x: Math.min(selectionStart.x, selectionEnd.x) * scaleX,
      y: Math.min(selectionStart.y, selectionEnd.y) * scaleY,
      width: Math.abs(selectionEnd.x - selectionStart.x) * scaleX,
      height: Math.abs(selectionEnd.y - selectionStart.y) * scaleY,
    };
    
    // Only capture if selection is large enough
    if (boundingBox.width > 10 && boundingBox.height > 10) {
      await handleManualCapture(boundingBox);
    }
    
    setIsSelecting(false);
    setSelectionStart(null);
    setSelectionEnd(null);
  };

  const cancelSelection = () => {
    setIsSelecting(false);
    setSelectionStart(null);
    setSelectionEnd(null);
  };

  const debugModals = async () => {
    if (!sessionId) return;
    
    try {
      const response = await fetch('/api/debug-modals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      
      if (response.ok) {
        const data = await response.json();
        console.log('Modal debug analysis:', data);
        alert(`Debug completed! Found ${data.modalAnalysis?.candidates?.length || 0} modal candidates. Check console for details.`);
      } else {
        console.error('Modal debug failed');
        alert('Debug failed - check console for details');
      }
    } catch (error) {
      console.error('Modal debug error:', error);
      alert('Debug error - check console for details');
    }
  };


  // Calculate selection rectangle for display
  const getSelectionStyle = () => {
    if (!selectionStart || !selectionEnd) return {};
    
    const left = Math.min(selectionStart.x, selectionEnd.x);
    const top = Math.min(selectionStart.y, selectionEnd.y);
    const width = Math.abs(selectionEnd.x - selectionStart.x);
    const height = Math.abs(selectionEnd.y - selectionStart.y);
    
    return {
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`,
    };
  };

  if (!sessionId) {
    return (
      <div className="bg-white rounded-lg shadow-lg p-6 h-[600px] flex items-center justify-center">
        <div className="text-center">
          <Monitor className="w-16 h-16 mx-auto mb-4 text-gray-400" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No Live Session</h3>
          <p className="text-gray-500">Start recording mode to launch a live browser session</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b">
        <div className="flex items-center gap-3">
          <Monitor className="w-5 h-5" />
          <h3 className="text-lg font-semibold">Live Browser Session</h3>
          {isActive && (
            <div className="flex items-center gap-2">
              <Circle className="w-3 h-3 fill-red-500 text-red-500 animate-pulse" />
              <span className="text-sm text-red-600 font-medium">Recording</span>
            </div>
          )}
        </div>
        
        <div className="flex items-center gap-4 text-sm text-gray-600">
          {session && (
            <>
              <div className="flex items-center gap-1">
                <Clock className="w-4 h-4" />
                <span>{formatTime(elapsedTime)}</span>
              </div>
              <div className="flex items-center gap-1">
                <Camera className="w-4 h-4" />
                <span>{session.screenshots.length}</span>
              </div>
              <div className="bg-gray-100 px-2 py-1 rounded text-xs">
                {session.actions.length} actions
              </div>
              
              {/* Manual Capture Controls */}
              {isActive && (
                <div className="flex items-center gap-2 ml-4 border-l pl-4">
                  <button
                    onClick={() => handleManualCapture()}
                    disabled={isCapturing}
                    className="flex items-center gap-1 px-2 py-1 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded text-xs disabled:opacity-50"
                  >
                    <Camera className="w-3 h-3" />
                    {isCapturing ? 'Capturing...' : 'Capture Screen'}
                  </button>
                  
                  <button
                    onClick={isSelecting ? cancelSelection : startSelection}
                    className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${
                      isSelecting 
                        ? 'bg-red-100 hover:bg-red-200 text-red-700' 
                        : 'bg-green-100 hover:bg-green-200 text-green-700'
                    }`}
                  >
                    <Crop className="w-3 h-3" />
                    {isSelecting ? 'Cancel' : 'Capture Area'}
                  </button>
                  
                  <button
                    onClick={debugModals}
                    className="flex items-center gap-1 px-2 py-1 bg-orange-100 hover:bg-orange-200 text-orange-700 rounded text-xs"
                  >
                    🔍 Debug Modals
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Browser Content */}
      <div className="relative">
        {isConnected ? (
          <div className="h-[500px] bg-gray-100 relative overflow-auto">
            {/* Stream browser screenshots */}
            <div className="relative">
              <img
                ref={imgRef}
                key={streamKey}
                src={`/api/browser-stream?sessionId=${sessionId}&t=${streamKey}`}
                alt="Live Browser View"
                className={`w-full min-h-full object-top ${isSelecting ? 'cursor-crosshair' : ''}`}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onError={(e) => {
                  // Retry on error
                  setTimeout(() => {
                    if (isActive) {
                      setStreamKey(Date.now());
                    }
                  }, 1000);
                }}
              />
              
              {/* Selection overlay */}
              {isSelecting && selectionStart && selectionEnd && (
                <div
                  className="absolute border-2 border-blue-500 bg-blue-500/20 pointer-events-none"
                  style={getSelectionStyle()}
                />
              )}
            </div>
            
            <div className="absolute top-4 left-4 right-4 flex justify-between pointer-events-none">
              <div className="bg-black/75 text-white px-3 py-1 rounded text-xs">
                {isSelecting ? 'Click and drag to select area to capture' : 'Full Page View - Scroll to see entire page'}
              </div>
              <div className="bg-blue-600/90 text-white px-3 py-1 rounded text-xs">
                ⚡ Interact directly with the browser window that opened
              </div>
            </div>
          </div>
        ) : (
          <div className="h-[500px] bg-gray-50 flex items-center justify-center">
            <div className="text-center">
              {isActive ? (
                <>
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4"></div>
                  <p className="text-gray-600">Connecting to browser session...</p>
                  <p className="text-xs text-gray-500 mt-2">Session ID: {sessionId}</p>
                </>
              ) : (
                <>
                  <Square className="w-8 h-8 mx-auto mb-4 text-gray-400" />
                  <p className="text-gray-600">Browser session stopped</p>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Status Footer */}
      {session && (
        <div className="p-3 bg-gray-50 border-t">
          <div className="flex items-center justify-between text-xs text-gray-600">
            <span>Current: {session.start_url}</span>
            <span>Started: {new Date(session.start_time).toLocaleTimeString()}</span>
          </div>
        </div>
      )}
    </div>
  );
}