'use client';

import { CrawlEvent } from '@/lib/types/crawler';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { 
  Navigation, 
  Eye, 
  LogIn, 
  Shield, 
  Camera, 
  AlertCircle, 
  Activity,
  Clock
} from 'lucide-react';

interface EventLogProps {
  events: CrawlEvent[];
}

export function EventLog({ events }: EventLogProps) {
  const getEventIcon = (type: CrawlEvent['type']) => {
    switch (type) {
      case 'navigation':
        return <Navigation className="w-4 h-4" />;
      case 'dom_detection':
        return <Eye className="w-4 h-4" />;
      case 'login':
        return <LogIn className="w-4 h-4" />;
      case 'captcha':
        return <Shield className="w-4 h-4" />;
      case 'screenshot':
        return <Camera className="w-4 h-4" />;
      case 'error':
        return <AlertCircle className="w-4 h-4" />;
      case 'action':
        return <Activity className="w-4 h-4" />;
      default:
        return <Clock className="w-4 h-4" />;
    }
  };

  const getEventColor = (type: CrawlEvent['type']) => {
    switch (type) {
      case 'navigation':
        return 'bg-blue-100 text-blue-800';
      case 'dom_detection':
        return 'bg-green-100 text-green-800';
      case 'login':
        return 'bg-purple-100 text-purple-800';
      case 'captcha':
        return 'bg-orange-100 text-orange-800';
      case 'screenshot':
        return 'bg-pink-100 text-pink-800';
      case 'error':
        return 'bg-red-100 text-red-800';
      case 'action':
        return 'bg-gray-100 text-gray-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const formatTime = (timestamp: string) => {
    return new Date(timestamp).toLocaleTimeString();
  };

  const truncateUrl = (url: string, maxLength: number = 50) => {
    if (url.length <= maxLength) return url;
    return url.substring(0, maxLength) + '...';
  };

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="w-5 h-5" />
          Event Log
          <Badge variant="secondary">{events.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-96">
          <div className="space-y-3">
            {events.length === 0 ? (
              <div className="text-center text-gray-500 py-8">
                <Activity className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p>No events yet. Start crawling to see activity.</p>
              </div>
            ) : (
              events.map((event) => (
                <div
                  key={event.id}
                  className="flex gap-3 p-3 bg-gray-50 rounded-lg border-l-4 border-l-blue-500"
                >
                  <div className="flex-shrink-0 mt-1">
                    {getEventIcon(event.type)}
                  </div>
                  
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <Badge className={getEventColor(event.type)}>
                            {event.type.replace('_', ' ')}
                          </Badge>
                          <span className="text-xs text-gray-500">
                            {formatTime(event.timestamp)}
                          </span>
                        </div>
                        
                        <p className="text-sm font-medium text-gray-900 mb-1">
                          {event.message}
                        </p>
                        
                        <p className="text-xs text-gray-600">
                          URL: {truncateUrl(event.url)}
                        </p>
                        
                        {event.details && (
                          <div className="mt-2 text-xs space-y-1">
                            {event.details.element_selector && (
                              <div className="text-gray-600">
                                <span className="font-medium">Selector:</span>{' '}
                                <code className="bg-gray-200 px-1 rounded">
                                  {event.details.element_selector}
                                </code>
                              </div>
                            )}
                            
                            {event.details.element_text && (
                              <div className="text-gray-600">
                                <span className="font-medium">Text:</span>{' '}
                                &quot;{event.details.element_text.substring(0, 50)}&quot;
                                {event.details.element_text.length > 50 && '...'}
                              </div>
                            )}
                            
                            {event.details.form_fields && (
                              <div className="text-gray-600">
                                <span className="font-medium">Form fields:</span>{' '}
                                <div className="mt-1 flex flex-wrap gap-1">
                                  {event.details.form_fields.map((field, idx) => (
                                    <code key={idx} className="bg-gray-200 px-1 rounded text-xs">
                                      {field}
                                    </code>
                                  ))}
                                </div>
                              </div>
                            )}
                            
                            {event.details.dom_elements_found !== undefined && (
                              <div className="text-gray-600">
                                <span className="font-medium">DOM elements:</span>{' '}
                                {event.details.dom_elements_found}
                              </div>
                            )}
                            
                            {event.details.links_discovered !== undefined && (
                              <div className="text-gray-600">
                                <span className="font-medium">Links found:</span>{' '}
                                {event.details.links_discovered}
                              </div>
                            )}
                            
                            {event.details.screenshot_path && (
                              <div className="text-gray-600">
                                <span className="font-medium">Screenshot:</span>{' '}
                                {event.details.screenshot_path}
                              </div>
                            )}
                            
                            {event.details.error_details && (
                              <div className="text-red-600">
                                <span className="font-medium">Error:</span>{' '}
                                {event.details.error_details}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}