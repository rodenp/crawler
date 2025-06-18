'use client';

import { useState, useEffect } from 'react';
import { CrawlerForm } from '@/components/crawler/crawler-form';
import { ProgressDisplay } from '@/components/crawler/progress-display';
import { EventLog } from '@/components/crawler/event-log';
import { CurrentPageDisplay } from '@/components/crawler/current-page-display';
import { BrowserPreview } from '@/components/crawler/browser-preview';
import { RecordingDisplay } from '@/components/recorder/recording-display';
import { LiveBrowserSession } from '@/components/recorder/live-browser-session';
import { CrawlConfig, CrawlProgress, CrawlResult } from '@/lib/types/crawler';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export default function Home() {
  const [isLoading, setIsLoading] = useState(false);
  const [crawlId, setCrawlId] = useState<string | null>(null);
  const [progress, setProgress] = useState<CrawlProgress | null>(null);
  const [result, setResult] = useState<CrawlResult | null>(null);
  const [currentMode, setCurrentMode] = useState<'crawl' | 'scrape' | 'record'>('scrape');
  
  // Training mode status tracking
  const [backendTrainingMode, setBackendTrainingMode] = useState<boolean | null>(null);

  // Poll backend training mode status when in record mode
  useEffect(() => {
    if (currentMode === 'record' && crawlId && isLoading) {
      const pollBackendTrainingMode = async () => {
        if (!crawlId) return;
        
        try {
          const response = await fetch('/api/modal-training-control', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: crawlId, action: 'get_status' }),
          });
          
          if (response.ok) {
            const data = await response.json();
            setBackendTrainingMode(data.trainingMode);
          } else {
            setBackendTrainingMode(null);
          }
        } catch (error) {
          setBackendTrainingMode(null);
        }
      };

      const interval = setInterval(pollBackendTrainingMode, 3000); // Check every 3 seconds
      pollBackendTrainingMode(); // Initial check
      return () => clearInterval(interval);
    }
  }, [currentMode, crawlId, isLoading]);
  

  const handleStartCrawl = async (config: CrawlConfig) => {
    setIsLoading(true);
    setProgress(null);
    setResult(null);
    setCurrentMode(config.mode);

    try {
      const response = await fetch('/api/crawler/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });

      if (!response.ok) {
        setIsLoading(false);
        throw new Error('Failed to start crawl');
      }

      const data = await response.json();
      setCrawlId(data.crawlId);

      // Poll for results without fake simulation
      // Keep isLoading true until crawl completes
      pollForResults(data.crawlId);
    } catch (error) {
      console.error('Error starting crawl:', error);
      alert('Failed to start crawl. Please try again.');
      setIsLoading(false);
    }
  };

  const handleStopCrawl = async () => {
    if (!crawlId) return;
    
    try {
      const response = await fetch(`/api/crawler/start?crawlId=${crawlId}`, {
        method: 'DELETE',
      });
      
      if (response.ok) {
        setProgress(prev => prev ? { ...prev, status: 'completed' } : null);
        setIsLoading(false);
      } else {
        console.error('Failed to stop crawl');
      }
    } catch (error) {
      console.error('Error stopping crawl:', error);
    }
  };

  const pollForResults = async (crawlId: string) => {
    const maxAttempts = 120; // Increased timeout for longer crawls
    let attempts = 0;

    const poll = async () => {
      if (attempts >= maxAttempts) {
        console.error('Polling timeout');
        setIsLoading(false);
        return;
      }

      try {
        const response = await fetch(`/api/crawler/start?crawlId=${crawlId}`);
        const data = await response.json();

        if (data.status === 'completed' && data.result) {
          setResult(data.result);
          setProgress(prev => prev ? { ...prev, status: 'completed' } : null);
          setIsLoading(false);
        } else if (data.status === 'running') {
          // Update progress with real crawl data if available
          if (data.progress) {
            setProgress(data.progress);
          } else {
            // Fallback progress update
            setProgress(prev => prev ? { 
              ...prev, 
              elapsed_time: Date.now() - new Date().getTime(),
              status: 'crawling' as const
            } : {
              current_url: '',
              pages_discovered: 0,
              pages_crawled: 0,
              success_rate: 0,
              elapsed_time: Date.now() - new Date().getTime(),
              status: 'crawling' as const
            });
          }
          attempts++;
          setTimeout(poll, 2000); // Poll every 2 seconds
        }
      } catch (error) {
        console.error('Polling error:', error);
        attempts++;
        setTimeout(poll, 3000);
      }
    };

    setTimeout(poll, 1000); // Start polling after 1 second
  };



  return (
    <main className="min-h-screen bg-gray-50">
      <div className="container mx-auto py-8 px-4">
        <h1 className="text-3xl font-bold text-center mb-8">
          Advanced Web Crawler
        </h1>

        <div className="grid grid-cols-1 xl:grid-cols-4 gap-6">
          {/* Configuration Panel */}
          <div className="xl:col-span-1">
            <div className="bg-white rounded-lg shadow p-6">
              <h2 className="text-xl font-semibold mb-4">Configure Crawl</h2>
              <CrawlerForm 
                onStart={handleStartCrawl} 
                onStop={handleStopCrawl}
                isLoading={isLoading}
                crawlId={crawlId}
              />
            </div>
          </div>

          {/* Browser Session / Preview Panel */}
          <div className="xl:col-span-2">
            {currentMode === 'record' ? (
              <LiveBrowserSession
                sessionId={crawlId}
                isActive={isLoading && progress?.status === 'recording'}
                onSessionData={(session) => {
                  // Update progress with session data
                  setProgress(prev => prev ? { ...prev, session } : null);
                }}
              />
            ) : (
              progress ? (
                <BrowserPreview
                  currentUrl={progress.current_url}
                  isActive={progress.status === 'crawling'}
                  actions={progress.browser_actions || []}
                  latestScreenshot={progress.latest_screenshot}
                />
              ) : (
                <BrowserPreview
                  currentUrl=""
                  isActive={false}
                  actions={[]}
                />
              )
            )}
          </div>

          {/* Status, Progress and Event Log */}
          <div className="xl:col-span-1 space-y-6">
            {progress && (
              <>
                <CurrentPageDisplay
                  currentUrl={progress.current_url}
                  pagesDiscovered={progress.pages_discovered}
                  pagesCrawled={progress.pages_crawled}
                  elapsedTime={progress.elapsed_time}
                  status={progress.status}
                />
                <ProgressDisplay progress={progress} />
              </>
            )}
            
            {progress?.events && (
              <EventLog events={progress.events} />
            )}

            {/* Recording Display for record mode */}
            {currentMode === 'record' && progress?.session && (
              <RecordingDisplay
                session={progress.session}
                currentUrl={progress.current_url}
                isActive={progress.status === 'recording'}
              />
            )}

            {/* Debug Controls for record mode */}
            {currentMode === 'record' && (
              <div className="bg-white rounded-lg shadow p-6">
                <h3 className="text-lg font-semibold mb-4">🚨 CRAWLER DEBUG PANEL 🚨</h3>
                
                {/* Training Mode Status Indicator */}
                <div className="mb-4 p-3 bg-yellow-50 rounded border border-yellow-200">
                  <div className="text-sm font-bold text-yellow-800">🔧 TRAINING MODE STATUS</div>
                  <div className="text-xs text-gray-700 mt-2">
                    Status: <span className={`font-mono font-bold ${
                      backendTrainingMode === null ? 'text-orange-600' :
                      backendTrainingMode ? 'text-blue-600' : 'text-green-600'
                    }`}>
                      {backendTrainingMode === null ? 'UNKNOWN' :
                       backendTrainingMode ? 'TRAINING MODE' : 'RECORDING MODE'}
                    </span>
                  </div>
                  <div className="text-xs text-gray-600 mt-1">
                    Session: {crawlId ? 'Active' : 'None'} | 
                    Loading: {isLoading ? 'Yes' : 'No'}
                  </div>
                  {backendTrainingMode === true && (
                    <div className="text-xs text-blue-600 mt-1 font-medium">
                      📚 Screenshots and recording DISABLED
                    </div>
                  )}
                  {backendTrainingMode === false && (
                    <div className="text-xs text-green-600 mt-1 font-medium">
                      🎥 Screenshots and recording ACTIVE
                    </div>
                  )}
                </div>
                
                {crawlId && isLoading && (
                  <div className="space-y-2">
                    <button
                      onClick={async () => {
                        try {
                          const response = await fetch('/api/debug-record-modals', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ crawlId }),
                          });
                          
                          if (response.ok) {
                            const data = await response.json();
                            console.log('Modal debug analysis:', data);
                            alert(`${data.message} Check console for details.`);
                          } else {
                            console.error('Modal debug failed');
                            alert('Debug failed - check console for details');
                          }
                        } catch (error) {
                          console.error('Modal debug error:', error);
                          alert('Debug error - check console for details');
                        }
                      }}
                      className="w-full flex items-center gap-2 px-3 py-2 bg-orange-100 hover:bg-orange-200 text-orange-700 rounded text-sm"
                    >
                      🔍 Debug Modals in Browser
                    </button>
                    <p className="text-xs text-gray-500">
                      Click this button when you have a modal open in the browser window to analyze what the detection system sees.
                    </p>
                  </div>
                )}
              </div>
            )}

            {result && (
              <div className="bg-white rounded-lg shadow p-6">
                <h3 className="text-lg font-semibold mb-4">Crawl Results</h3>
                
                <Tabs defaultValue="summary" className="w-full">
                  <TabsList className="grid w-full grid-cols-3">
                    <TabsTrigger value="summary">Summary</TabsTrigger>
                    <TabsTrigger value="pages">Pages</TabsTrigger>
                    <TabsTrigger value="errors">Errors</TabsTrigger>
                  </TabsList>

                  <TabsContent value="summary" className="space-y-3">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <p className="text-sm text-gray-600">Total Pages</p>
                        <p className="text-2xl font-bold">{result.crawl_metadata.total_pages}</p>
                      </div>
                      <div>
                        <p className="text-sm text-gray-600">Success Rate</p>
                        <p className="text-2xl font-bold">
                          {((result.crawl_metadata.successful_crawls / result.crawl_metadata.total_pages) * 100).toFixed(1)}%
                        </p>
                      </div>
                    </div>
                    
                    <div>
                      <p className="text-sm text-gray-600">Domain</p>
                      <p className="font-mono">{result.site_structure.domain}</p>
                    </div>
                    
                    <div>
                      <p className="text-sm text-gray-600">Crawl Duration</p>
                      <p>
                        {new Date(result.crawl_metadata.end_time!).getTime() - 
                         new Date(result.crawl_metadata.start_time).getTime()} ms
                      </p>
                    </div>
                  </TabsContent>

                  <TabsContent value="pages" className="space-y-2 max-h-96 overflow-y-auto">
                    {result.pages.map((page, index) => (
                      <div key={index} className="border rounded p-3">
                        <p className="font-medium text-sm">{page.title || 'Untitled'}</p>
                        <p className="text-xs text-gray-600 font-mono">{page.url}</p>
                        <div className="flex gap-4 mt-2 text-xs text-gray-500">
                          <span>Depth: {page.depth}</span>
                          <span>Status: {page.status_code}</span>
                          <span>Load: {page.load_time}ms</span>
                        </div>
                      </div>
                    ))}
                  </TabsContent>

                  <TabsContent value="errors" className="space-y-2 max-h-96 overflow-y-auto">
                    {result.errors.length === 0 ? (
                      <p className="text-gray-500 text-center py-4">No errors encountered</p>
                    ) : (
                      result.errors.map((error, index) => (
                        <div key={index} className="border border-red-200 rounded p-3">
                          <p className="font-mono text-xs">{error.url}</p>
                          <p className="text-sm text-red-600 mt-1">{error.error_message}</p>
                          <p className="text-xs text-gray-500 mt-1">
                            Type: {error.error_type} | Retries: {error.retry_attempts}
                          </p>
                        </div>
                      ))
                    )}
                  </TabsContent>
                </Tabs>

                <div className="mt-4">
                  <button
                    onClick={() => {
                      const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `crawl_${result.crawl_metadata.crawl_id}.json`;
                      a.click();
                    }}
                    className="text-sm text-blue-600 hover:text-blue-800"
                  >
                    Download Full Results
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
