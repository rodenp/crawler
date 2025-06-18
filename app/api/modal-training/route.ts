import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

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

    const sessionDir = path.join(process.cwd(), 'recordings', `session_${sessionId}`);
    const trainingDir = path.join(sessionDir, 'modal-training');
    
    try {
      // Check if training directory exists
      await fs.access(trainingDir);
      
      // Get training summary
      const summaryFile = path.join(trainingDir, 'training-summary.json');
      let summary = null;
      try {
        const summaryContent = await fs.readFile(summaryFile, 'utf-8');
        const parsedSummary = JSON.parse(summaryContent);
        
        // Convert plain objects back to Maps for proper functionality
        if (parsedSummary && parsedSummary.commonPatterns) {
          summary = {
            ...parsedSummary,
            commonPatterns: {
              classNames: new Map(Object.entries(parsedSummary.commonPatterns.classNames || {})),
              positions: new Map(Object.entries(parsedSummary.commonPatterns.positions || {})),
              tagNames: new Map(Object.entries(parsedSummary.commonPatterns.tagNames || {})),
              zIndexRanges: new Map(Object.entries(parsedSummary.commonPatterns.zIndexRanges || {}))
            }
          };
        } else {
          summary = parsedSummary;
        }
      } catch (error) {
        // Summary doesn't exist yet
      }

      // Get all training files
      const files = await fs.readdir(trainingDir);
      const trainingFiles = files.filter(file => file.startsWith('training-') && file.endsWith('.json'));
      
      const trainingData = [];
      for (const file of trainingFiles) {
        try {
          const filePath = path.join(trainingDir, file);
          const content = await fs.readFile(filePath, 'utf-8');
          trainingData.push(JSON.parse(content));
        } catch (error) {
          console.error(`Error reading training file ${file}:`, error);
        }
      }

      return NextResponse.json({
        sessionId,
        summary,
        trainingData,
        totalSamples: trainingData.length
      });

    } catch (error) {
      // Training directory doesn't exist
      return NextResponse.json({
        sessionId,
        summary: null,
        trainingData: [],
        totalSamples: 0,
        message: 'No training data found for this session'
      });
    }

  } catch (error) {
    console.error('Modal training API error:', error);
    return NextResponse.json(
      { error: 'Failed to retrieve training data' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const { sessionId, action, trainingData } = await request.json();
    
    if (!sessionId) {
      return NextResponse.json(
        { error: 'Session ID is required' },
        { status: 400 }
      );
    }

    if (action === 'clear') {
      // Clear all training data for session
      const sessionDir = path.join(process.cwd(), 'recordings', `session_${sessionId}`);
      const trainingDir = path.join(sessionDir, 'modal-training');
      
      try {
        await fs.rm(trainingDir, { recursive: true, force: true });
        return NextResponse.json({
          message: 'Training data cleared successfully'
        });
      } catch (error) {
        return NextResponse.json(
          { error: 'Failed to clear training data' },
          { status: 500 }
        );
      }
    }

    if (action === 'export') {
      // Export training data for machine learning
      const sessionDir = path.join(process.cwd(), 'recordings', `session_${sessionId}`);
      const trainingDir = path.join(sessionDir, 'modal-training');
      
      try {
        const files = await fs.readdir(trainingDir);
        const trainingFiles = files.filter(file => file.startsWith('training-') && file.endsWith('.json'));
        
        const exportData = {
          exportDate: new Date().toISOString(),
          sessionId,
          samples: [] as any[]
        };

        for (const file of trainingFiles) {
          const filePath = path.join(trainingDir, file);
          const content = await fs.readFile(filePath, 'utf-8');
          exportData.samples.push(JSON.parse(content));
        }

        // Create export file
        const exportFile = path.join(trainingDir, `export-${Date.now()}.json`);
        await fs.writeFile(exportFile, JSON.stringify(exportData, null, 2));

        return NextResponse.json({
          message: 'Training data exported successfully',
          exportFile,
          totalSamples: exportData.samples.length
        });

      } catch (error) {
        return NextResponse.json(
          { error: 'Failed to export training data' },
          { status: 500 }
        );
      }
    }

    return NextResponse.json(
      { error: 'Invalid action' },
      { status: 400 }
    );

  } catch (error) {
    console.error('Modal training API error:', error);
    return NextResponse.json(
      { error: 'Failed to process training request' },
      { status: 500 }
    );
  }
}