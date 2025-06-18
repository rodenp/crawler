'use client';

import { RecordingSession } from '@/lib/types/crawler';
import { Clock, Camera, MousePointer, Keyboard, Navigation } from 'lucide-react';

interface RecordingDisplayProps {
  session: RecordingSession | null;
  currentUrl: string;
  isActive: boolean;
}

export function RecordingDisplay({ session, currentUrl, isActive }: RecordingDisplayProps) {
  if (!session) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold mb-4">Manual Recording</h3>
        <p className="text-gray-500">No recording session active</p>
      </div>
    );
  }

  const elapsedTime = session.end_time 
    ? new Date(session.end_time).getTime() - new Date(session.start_time).getTime()
    : new Date().getTime() - new Date(session.start_time).getTime();

  const formatTime = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  const getActionIcon = (type: string) => {
    switch (type) {
      case 'navigation': return <Navigation className="w-4 h-4" />;
      case 'click': return <MousePointer className="w-4 h-4" />;
      case 'type':
      case 'keydown':
      case 'keyup': return <Keyboard className="w-4 h-4" />;
      default: return <Camera className="w-4 h-4" />;
    }
  };

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold">Manual Recording</h3>
        <div className="flex items-center gap-2">
          {isActive && (
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse"></div>
              <span className="text-sm text-red-600">Recording</span>
            </div>
          )}
        </div>
      </div>

      <div className="space-y-4">
        {/* Current Status */}
        <div className="grid grid-cols-2 gap-4 p-4 bg-gray-50 rounded-lg">
          <div>
            <p className="text-sm text-gray-600">Current URL</p>
            <p className="font-mono text-xs">{currentUrl || session.start_url}</p>
          </div>
          <div>
            <p className="text-sm text-gray-600">Duration</p>
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4" />
              <span>{formatTime(elapsedTime)}</span>
            </div>
          </div>
          <div>
            <p className="text-sm text-gray-600">Actions Recorded</p>
            <p className="text-2xl font-bold">{session.actions.length}</p>
          </div>
          <div>
            <p className="text-sm text-gray-600">Screenshots</p>
            <div className="flex items-center gap-2">
              <Camera className="w-4 h-4" />
              <span>{session.screenshots.length}</span>
            </div>
          </div>
        </div>

        {/* Recent Actions */}
        <div>
          <h4 className="font-medium mb-2">Recent Actions</h4>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {session.actions.slice(-10).reverse().map((action) => (
              <div key={action.id} className="flex items-start gap-2 p-2 bg-gray-50 rounded text-sm">
                <div className="mt-0.5">
                  {getActionIcon(action.type)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium leading-tight" style={{
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden'
                  }}>
                    {action.actions?.[0]?.action_description || 'Unknown action'}
                  </p>
                  <div className="flex items-center gap-1 mt-1 text-xs text-gray-500 flex-wrap">
                    <span>{new Date(action.timestamp).toLocaleTimeString()}</span>
                    {action.element_type && (
                      <span className="bg-gray-100 px-1 rounded text-xs">{action.element_type}</span>
                    )}
                    {action.element_id && (
                      <span className="text-blue-600 truncate max-w-16">#{action.element_id}</span>
                    )}
                    {action.element_href && (
                      <span className="text-blue-500 truncate max-w-24">
                        → {action.element_href.startsWith('http') ? new URL(action.element_href).pathname : action.element_href}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {session.actions.length === 0 && (
              <p className="text-gray-500 text-center py-4">No actions recorded yet</p>
            )}
          </div>
        </div>

        {/* Screenshots Gallery */}
        {session.screenshots.length > 0 && (
          <div>
            <h4 className="font-medium mb-2">Screenshots ({session.screenshots.length})</h4>
            <div className="grid grid-cols-3 gap-2">
              {session.screenshots.slice(-6).map((screenshot) => (
                <div key={screenshot} className="aspect-video bg-gray-100 rounded overflow-hidden relative group">
                  <img
                    src={`/api/recording-screenshots/${screenshot}?sessionId=${session.id}`}
                    alt="Recording screenshot"
                    className="w-full h-full object-cover object-top cursor-pointer hover:opacity-80"
                    onClick={() => window.open(`/api/recording-screenshots/${screenshot}?sessionId=${session.id}`, '_blank')}
                  />
                  <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <span className="text-white text-xs">Click to view full page</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}