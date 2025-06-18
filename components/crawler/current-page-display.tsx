'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Globe, Clock, CheckCircle } from 'lucide-react';

interface CurrentPageDisplayProps {
  currentUrl: string;
  pagesDiscovered: number;
  pagesCrawled: number;
  elapsedTime: number;
  status: 'idle' | 'crawling' | 'completed' | 'error' | 'recording';
}

export function CurrentPageDisplay({
  currentUrl,
  pagesDiscovered,
  pagesCrawled,
  elapsedTime,
  status
}: CurrentPageDisplayProps) {
  const formatTime = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'crawling':
        return 'bg-blue-100 text-blue-800';
      case 'recording':
        return 'bg-red-100 text-red-800';
      case 'completed':
        return 'bg-green-100 text-green-800';
      case 'error':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const truncateUrl = (url: string, maxLength: number = 60) => {
    if (!url || url.length <= maxLength) return url || 'No URL';
    return url.substring(0, maxLength) + '...';
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="w-5 h-5" />
          Current Status
          <Badge className={getStatusColor(status)}>
            {status}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Globe className="w-4 h-4 text-gray-500" />
              <span className="text-sm font-medium">Current Page</span>
            </div>
            <p className="text-sm text-gray-600 break-all">
              {truncateUrl(currentUrl)}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <CheckCircle className="w-4 h-4 text-green-500" />
                <span className="text-sm font-medium">Pages Crawled</span>
              </div>
              <p className="text-lg font-bold text-green-600">{pagesCrawled}</p>
            </div>

            <div>
              <div className="flex items-center gap-2 mb-1">
                <Globe className="w-4 h-4 text-blue-500" />
                <span className="text-sm font-medium">Pages Discovered</span>
              </div>
              <p className="text-lg font-bold text-blue-600">{pagesDiscovered}</p>
            </div>
          </div>

          <div>
            <div className="flex items-center gap-2 mb-1">
              <Clock className="w-4 h-4 text-gray-500" />
              <span className="text-sm font-medium">Elapsed Time</span>
            </div>
            <p className="text-sm text-gray-600">{formatTime(elapsedTime)}</p>
          </div>

          {status === 'crawling' && (
            <div className="mt-4">
              <div className="flex items-center gap-2">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
                <span className="text-sm text-blue-600">Crawling in progress...</span>
              </div>
            </div>
          )}
          
          {status === 'recording' && (
            <div className="mt-4">
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 bg-red-500 rounded-full animate-pulse"></div>
                <span className="text-sm text-red-600">Recording session active...</span>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}