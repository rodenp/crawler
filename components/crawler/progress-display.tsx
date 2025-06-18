'use client';

import { CrawlProgress } from '@/lib/types/crawler';
import { Progress } from '@/components/ui/progress';
import { Clock, Globe, CheckCircle } from 'lucide-react';

interface ProgressDisplayProps {
  progress: CrawlProgress;
}

export function ProgressDisplay({ progress }: ProgressDisplayProps) {
  const formatTime = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  };

  return (
    <div className="space-y-4 p-6 bg-white rounded-lg shadow">
      <h3 className="text-lg font-semibold">Crawl Progress</h3>
      
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-600">Status</span>
          <span className={`text-sm font-medium ${
            progress.status === 'crawling' ? 'text-blue-600' :
            progress.status === 'completed' ? 'text-green-600' :
            progress.status === 'error' ? 'text-red-600' :
            'text-gray-600'
          }`}>
            {progress.status.charAt(0).toUpperCase() + progress.status.slice(1)}
          </span>
        </div>

        {progress.current_url && (
          <div className="flex items-start gap-2">
            <Globe className="w-4 h-4 text-gray-400 mt-1" />
            <div className="flex-1">
              <p className="text-sm text-gray-600">Current URL</p>
              <p className="text-sm font-mono break-all">{progress.current_url}</p>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div className="flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-green-500" />
            <div>
              <p className="text-sm text-gray-600">Pages Crawled</p>
              <p className="text-lg font-semibold">{progress.pages_crawled}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Globe className="w-4 h-4 text-blue-500" />
            <div>
              <p className="text-sm text-gray-600">Pages Discovered</p>
              <p className="text-lg font-semibold">{progress.pages_discovered}</p>
            </div>
          </div>
        </div>

        <div>
          <div className="flex justify-between text-sm mb-1">
            <span className="text-gray-600">Success Rate</span>
            <span className="font-medium">{progress.success_rate.toFixed(1)}%</span>
          </div>
          <Progress value={progress.success_rate} className="h-2" />
        </div>

        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-gray-400" />
          <div className="flex-1 flex justify-between">
            <span className="text-sm text-gray-600">Elapsed Time</span>
            <span className="text-sm font-medium">{formatTime(progress.elapsed_time)}</span>
          </div>
        </div>

        {progress.estimated_completion && (
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-gray-400" />
            <div className="flex-1 flex justify-between">
              <span className="text-sm text-gray-600">Estimated Completion</span>
              <span className="text-sm font-medium">
                {formatTime(progress.estimated_completion - progress.elapsed_time)}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}