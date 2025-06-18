'use client';

import { useState, useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { 
  Monitor, 
  Play, 
  Pause, 
  RefreshCw, 
  MousePointer,
  Keyboard,
  Eye,
  Download,
  Maximize2,
  Minimize2
} from 'lucide-react';

import { BrowserAction } from '@/lib/types/crawler';

interface BrowserPreviewProps {
  currentUrl: string;
  isActive: boolean;
  actions: BrowserAction[];
  latestScreenshot?: string;
}

export function BrowserPreview({ 
  currentUrl, 
  isActive, 
  actions = [], 
  latestScreenshot 
}: BrowserPreviewProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showActions, setShowActions] = useState(true);
  const [actionOverlays, setActionOverlays] = useState<BrowserAction[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const screenshotRef = useRef<HTMLImageElement>(null);

  // Auto-refresh screenshot display for live streaming
  useEffect(() => {
    if (isActive && latestScreenshot) {
      // Force re-render when screenshot updates
      const img = screenshotRef.current;
      if (img) {
        img.src = latestScreenshot + '?t=' + Date.now(); // Cache busting
      }
    }
  }, [latestScreenshot, isActive]);

  // Show recent actions as overlays
  useEffect(() => {
    if (actions.length > 0) {
      const recentActions = actions.slice(-3); // Show last 3 actions
      setActionOverlays(recentActions);

      // Clear overlays after 5 seconds
      const timeout = setTimeout(() => {
        setActionOverlays([]);
      }, 5000);

      return () => clearTimeout(timeout);
    }
  }, [actions]);

  const getActionIcon = (type: BrowserAction['type']) => {
    switch (type) {
      case 'click':
        return <MousePointer className="w-3 h-3" />;
      case 'type':
        return <Keyboard className="w-3 h-3" />;
      case 'scroll':
        return <RefreshCw className="w-3 h-3" />;
      case 'navigate':
        return <Eye className="w-3 h-3" />;
      case 'screenshot':
        return <Download className="w-3 h-3" />;
      case 'hover':
        return <MousePointer className="w-3 h-3" />;
      case 'wait':
        return <RefreshCw className="w-3 h-3" />;
      default:
        return <MousePointer className="w-3 h-3" />;
    }
  };

  const getActionColor = (type: BrowserAction['type']) => {
    switch (type) {
      case 'click':
        return 'bg-blue-500';
      case 'type':
        return 'bg-green-500';
      case 'scroll':
        return 'bg-yellow-500';
      case 'navigate':
        return 'bg-purple-500';
      case 'screenshot':
        return 'bg-pink-500';
      case 'hover':
        return 'bg-orange-500';
      case 'wait':
        return 'bg-gray-500';
      default:
        return 'bg-gray-500';
    }
  };

  const downloadScreenshot = () => {
    if (latestScreenshot) {
      const link = document.createElement('a');
      link.href = latestScreenshot;
      link.download = `screenshot-${Date.now()}.png`;
      link.click();
    }
  };

  return (
    <Card className={`transition-all duration-300 ${isExpanded ? 'fixed inset-4 z-50' : 'h-full'}`}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Monitor className="w-5 h-5" />
            Browser Preview
            <Badge variant={isActive ? "default" : "secondary"}>
              {isActive ? 'Active' : 'Idle'}
            </Badge>
          </CardTitle>
          
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowActions(!showActions)}
              title="Toggle action overlays"
            >
              <Eye className="w-4 h-4" />
            </Button>
            
            <Button
              variant="ghost"
              size="sm"
              onClick={downloadScreenshot}
              title="Download screenshot"
              disabled={!latestScreenshot}
            >
              <Download className="w-4 h-4" />
            </Button>
            
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsExpanded(!isExpanded)}
              title={isExpanded ? "Minimize" : "Maximize"}
            >
              {isExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </Button>
          </div>
        </div>
        
        {currentUrl && (
          <div className="text-sm text-gray-600 truncate" title={currentUrl}>
            📍 {currentUrl}
          </div>
        )}
      </CardHeader>
      
      <CardContent>
        <div className={`relative bg-gray-100 rounded-lg overflow-hidden ${isExpanded ? 'h-full' : 'h-96'}`}>
          {/* Browser Screenshot */}
          <div className="relative w-full h-full">
            {latestScreenshot ? (
              <>
                <img
                  ref={screenshotRef}
                  src={latestScreenshot}
                  alt="Browser Screenshot"
                  className="w-full h-full object-cover bg-white rounded-lg"
                  onError={() => console.log('Screenshot failed to load')}
                  style={{ objectPosition: 'top left' }}
                />
                
                {/* Action Overlays */}
                {showActions && actionOverlays.map((action) => (
                  <div
                    key={action.id}
                    className={`absolute animate-ping ${getActionColor(action.type)} rounded-full w-4 h-4 flex items-center justify-center text-white text-xs`}
                    style={{
                      left: action.position ? `${action.position.x}px` : '50%',
                      top: action.position ? `${action.position.y}px` : '50%',
                      transform: 'translate(-50%, -50%)'
                    }}
                    title={`${action.type}: ${action.element_selector || action.element_text || action.input_text || action.url || ''}`}
                  >
                    {getActionIcon(action.type)}
                  </div>
                ))}
              </>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-gray-500">
                <Monitor className="w-16 h-16 mb-4 opacity-50" />
                <p className="text-lg font-medium">Browser Preview</p>
                <p className="text-sm">
                  {isActive ? 'Connecting to live browser session...' : 'Start crawling to see live browser activity'}
                </p>
              </div>
            )}
          </div>

          {/* Action History Panel */}
          {actions.length > 0 && (
            <div className="absolute bottom-0 left-0 right-0 bg-black bg-opacity-80 text-white p-2">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-medium">Recent Actions:</span>
                <div className="flex gap-2 overflow-x-auto">
                  {actions.slice(-5).map((action, index) => (
                    <div
                      key={action.id}
                      className="flex items-center gap-1 bg-white bg-opacity-20 px-2 py-1 rounded flex-shrink-0"
                    >
                      {getActionIcon(action.type)}
                      <span className="capitalize">{action.type}</span>
                      {action.element_selector && (
                        <code className="text-xs opacity-75">
                          {action.element_selector.length > 20 ? action.element_selector.substring(0, 20) + '...' : action.element_selector}
                        </code>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Loading Indicator */}
          {isActive && !latestScreenshot && (
            <div className="absolute inset-0 bg-white bg-opacity-75 flex items-center justify-center">
              <div className="flex items-center gap-2 text-gray-600">
                <RefreshCw className="w-5 h-5 animate-spin" />
                <span>Connecting to live browser session...</span>
              </div>
            </div>
          )}
        </div>

        {/* Browser Controls */}
        <div className="mt-4 flex items-center justify-between text-sm text-gray-600">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1">
              <div className={`w-2 h-2 rounded-full ${isActive ? 'bg-green-500' : 'bg-gray-400'}`}></div>
              <span>{isActive ? 'Recording' : 'Stopped'}</span>
            </div>
            
            {actions.length > 0 && (
              <div>
                {actions.length} action{actions.length !== 1 ? 's' : ''} recorded
              </div>
            )}
          </div>
          
          <div className="flex items-center gap-2 text-xs">
            <span>Live updates: 2s</span>
            <div className="w-1 h-1 bg-gray-400 rounded-full"></div>
            <span>Resolution: 1200x800</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}