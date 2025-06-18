'use client';

import { useState } from 'react';
import { CrawlConfig } from '@/lib/types/crawler';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ChevronDown, ChevronUp, Play, Settings, Square, Circle, StopCircle, BookOpen } from 'lucide-react';

interface CrawlerFormProps {
  onStart: (config: CrawlConfig) => void;
  onStop?: () => void;
  isLoading?: boolean;
  crawlId?: string | null;
}

export function CrawlerForm({ onStart, onStop, isLoading, crawlId }: CrawlerFormProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  
  // Training mode state
  const [isTrainingMode, setIsTrainingMode] = useState(false);
  const [trainingModeLoading, setTrainingModeLoading] = useState(false);
  const [config, setConfig] = useState<CrawlConfig>({
    startUrl: '',
    maxDepth: 3,
    rateLimit: 10,
    mode: 'scrape', // New: default to scrape mode
    sampleMode: false, // New: sample mode toggle
    followLinkTags: ['a'], // New: default to anchor tags only
    domainRestrictions: {
      stayWithinDomain: true,
      includeSubdomains: false,
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (config.startUrl) {
      // Include training mode in the config for record mode
      const configWithTrainingMode = {
        ...config,
        trainingMode: config.mode === 'record' ? isTrainingMode : undefined
      };
      console.log(`[Training Mode] Starting with config:`, configWithTrainingMode);
      onStart(configWithTrainingMode);
    }
  };

  const handleStartRecording = async () => {
    if (!crawlId || !config.startUrl) return;
    
    try {
      const response = await fetch('/api/recorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start',
          crawlId,
          startUrl: config.startUrl
        }),
      });
      
      if (response.ok) {
        setIsRecording(true);
      } else {
        console.error('Failed to start recording');
      }
    } catch (error) {
      console.error('Error starting recording:', error);
    }
  };

  const handleStopRecording = async () => {
    if (!crawlId) return;
    
    try {
      const response = await fetch('/api/recorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'stop',
          crawlId
        }),
      });
      
      if (response.ok) {
        setIsRecording(false);
        const data = await response.json();
        console.log('Recording session saved:', data.session);
      } else {
        console.error('Failed to stop recording');
      }
    } catch (error) {
      console.error('Error stopping recording:', error);
    }
  };

  // Training mode functions
  const syncTrainingModeToBackend = async (mode: boolean) => {
    if (!crawlId) return;
    
    try {
      const action = mode ? 'enable_training' : 'disable_training';
      const response = await fetch('/api/modal-training-control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: crawlId, action }),
      });
      
      if (response.ok) {
        const data = await response.json();
        console.log(`[Training Mode] Backend sync successful: ${data.trainingMode ? 'enabled' : 'disabled'} for domain: ${data.domain}`);
      } else {
        console.error(`[Training Mode] Backend sync failed: ${response.status}`);
      }
    } catch (error) {
      console.error('Training mode sync error:', error);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <label htmlFor="url" className="block text-sm font-medium mb-2">
          Start URL
        </label>
        <input
          id="url"
          type="url"
          required
          placeholder="https://example.com"
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          value={config.startUrl}
          onChange={(e) => setConfig({ ...config, startUrl: e.target.value })}
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-2">
          Mode
        </label>
        <div className="space-y-2">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="mode"
              value="crawl"
              checked={config.mode === 'crawl'}
              onChange={(e) => setConfig({ ...config, mode: e.target.value as 'crawl' | 'scrape' | 'record' })}
              className="text-blue-600"
            />
            <span>Crawl (Navigation only)</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="mode"
              value="scrape"
              checked={config.mode === 'scrape'}
              onChange={(e) => setConfig({ ...config, mode: e.target.value as 'crawl' | 'scrape' | 'record' })}
              className="text-blue-600"
            />
            <span>Scrape (Full content)</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="mode"
              value="record"
              checked={config.mode === 'record'}
              onChange={(e) => setConfig({ ...config, mode: e.target.value as 'crawl' | 'scrape' | 'record' })}
              className="text-blue-600"
            />
            <span>Record (Manual navigation)</span>
          </label>
        </div>
        <p className="text-xs text-gray-500 mt-1">
          {config.mode === 'crawl' && 'Crawl mode extracts only navigation structure automatically.'}
          {config.mode === 'scrape' && 'Scrape mode extracts full page content automatically.'}
          {config.mode === 'record' && 'Record mode lets you manually navigate while capturing screenshots and actions.'}
        </p>
        
        {/* Training Mode Toggle - show when Record mode is selected */}
        {config.mode === 'record' && (
          <div className="mt-3 p-3 bg-gray-50 rounded-lg border">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={isTrainingMode}
                onChange={(e) => {
                  const newMode = e.target.checked;
                  console.log(`[Training Mode] Checkbox toggled to: ${newMode}`);
                  setIsTrainingMode(newMode);
                }}
                className="text-blue-600"
              />
              <span className="text-sm font-medium">Training Mode</span>
            </label>
            <p className="text-xs text-gray-500 mt-1">
              Train modal components without recording screenshots or actions
            </p>
          </div>
        )}
      </div>

      <div>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={config.sampleMode}
            onChange={(e) => setConfig({ ...config, sampleMode: e.target.checked })}
            className="text-blue-600"
          />
          <span className="text-sm font-medium">Sample Mode</span>
        </label>
        <p className="text-xs text-gray-500 mt-1">
          Only retrieve one item from lists (useful for testing)
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium mb-2">
          Crawl Depth: {config.maxDepth}
        </label>
        <Slider
          value={[config.maxDepth]}
          onValueChange={([value]) => setConfig({ ...config, maxDepth: value })}
          max={10}
          min={1}
          step={1}
          className="w-full"
        />
      </div>

      <div>
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-gray-900"
        >
          <Settings className="w-4 h-4" />
          Advanced Options
          {showAdvanced ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      </div>

      {showAdvanced && (
        <div className="space-y-4 p-4 bg-gray-50 rounded-lg">
          <Tabs defaultValue="general" className="w-full">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="general">General</TabsTrigger>
              <TabsTrigger value="auth">Authentication</TabsTrigger>
              <TabsTrigger value="filters">Filters</TabsTrigger>
            </TabsList>

            <TabsContent value="general" className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">
                  Rate Limit (requests/minute): {config.rateLimit}
                </label>
                <Slider
                  value={[config.rateLimit]}
                  onValueChange={([value]) => setConfig({ ...config, rateLimit: value })}
                  max={60}
                  min={1}
                  step={1}
                  className="w-full"
                />
              </div>

              <div className="space-y-2">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={config.domainRestrictions?.stayWithinDomain}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        domainRestrictions: {
                          ...config.domainRestrictions!,
                          stayWithinDomain: e.target.checked,
                        },
                      })
                    }
                  />
                  Stay within domain
                </label>
                
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={config.domainRestrictions?.includeSubdomains}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        domainRestrictions: {
                          ...config.domainRestrictions!,
                          includeSubdomains: e.target.checked,
                        },
                      })
                    }
                  />
                  Include subdomains
                </label>
              </div>
            </TabsContent>

            <TabsContent value="auth" className="space-y-4">
              <div>
                <label htmlFor="username" className="block text-sm font-medium mb-2">
                  Username
                </label>
                <input
                  id="username"
                  type="text"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                  value={config.loginCredentials?.username || ''}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      loginCredentials: {
                        ...config.loginCredentials!,
                        username: e.target.value,
                        password: config.loginCredentials?.password || '',
                      },
                    })
                  }
                />
              </div>

              <div>
                <label htmlFor="password" className="block text-sm font-medium mb-2">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                  value={config.loginCredentials?.password || ''}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      loginCredentials: {
                        ...config.loginCredentials!,
                        username: config.loginCredentials?.username || '',
                        password: e.target.value,
                      },
                    })
                  }
                />
              </div>
            </TabsContent>

            <TabsContent value="filters" className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">
                  Link Tags to Follow
                </label>
                <div className="space-y-2">
                  {[
                    { tag: 'a', label: 'Anchor tags (<a>)' },
                    { tag: 'button', label: 'Button elements (<button>)' },
                    { tag: 'form', label: 'Form submissions (<form>)' },
                  ].map(({ tag, label }) => (
                    <label key={tag} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={config.followLinkTags?.includes(tag) || false}
                        onChange={(e) => {
                          const currentTags = config.followLinkTags || [];
                          if (e.target.checked) {
                            setConfig({
                              ...config,
                              followLinkTags: [...currentTags, tag],
                            });
                          } else {
                            setConfig({
                              ...config,
                              followLinkTags: currentTags.filter(t => t !== tag),
                            });
                          }
                        }}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">
                  File Type Filters
                </label>
                <div className="space-y-2">
                  {['images', 'documents', 'videos'].map((type) => (
                    <label key={type} className="flex items-center gap-2">
                      <input type="checkbox" />
                      Include {type}
                    </label>
                  ))}
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </div>
      )}

      <div className="space-y-2">
        <div className="flex gap-2">
          <Button
            type="submit"
            className="flex-1"
            disabled={!config.startUrl || isLoading}
          >
            {isLoading ? (
              <>Loading...</>
            ) : (
              <>
                <Play className="w-4 h-4 mr-2" />
                {config.mode === 'record' ? 'Start Recording' : 'Start Crawling'}
              </>
            )}
          </Button>
          
          {isLoading && onStop && (
            <Button
              type="button"
              variant="destructive"
              onClick={onStop}
              className="px-4"
            >
              <Square className="w-4 h-4 mr-2" />
              Stop
            </Button>
          )}
        </div>
        
        {isLoading && crawlId && config.mode !== 'record' && (
          <div className="flex gap-2">
            {!isRecording ? (
              <Button
                type="button"
                variant="outline"
                onClick={handleStartRecording}
                className="flex-1"
                disabled={!config.startUrl}
              >
                <Circle className="w-4 h-4 mr-2 text-red-500" />
                Start Recording
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                onClick={handleStopRecording}
                className="flex-1"
              >
                <StopCircle className="w-4 h-4 mr-2 text-red-500" />
                Stop Recording
              </Button>
            )}
          </div>
        )}
      </div>
    </form>
  );
}