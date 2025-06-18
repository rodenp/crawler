import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) {
  try {
    const { filename } = await params;
    
    // Security check - prevent directory traversal
    if (filename.includes('..') || filename.includes('/')) {
      return NextResponse.json(
        { error: 'Invalid filename' },
        { status: 400 }
      );
    }

    // Get session ID from query parameter since it's no longer in filename
    const url = new URL(request.url);
    const sessionId = url.searchParams.get('sessionId');
    
    if (!sessionId) {
      return NextResponse.json(
        { error: 'sessionId query parameter is required' },
        { status: 400 }
      );
    }
    
    // Look for recording screenshots in the correct session folder
    const screenshotPath = path.join(
      process.cwd(),
      'recordings',
      `session_${sessionId}`,
      'screenshots',
      filename
    );

    // Check if file exists
    try {
      await fs.access(screenshotPath);
    } catch {
      return NextResponse.json(
        { error: 'Screenshot not found' },
        { status: 404 }
      );
    }

    // Read the file
    const imageBuffer = await fs.readFile(screenshotPath);
    
    // Determine content type based on extension
    const ext = path.extname(filename).toLowerCase();
    const contentType = ext === '.png' ? 'image/png' : 'image/jpeg';

    // Return the image
    return new NextResponse(imageBuffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
      },
    });
    
  } catch (error) {
    console.error('Error serving recording screenshot:', error);
    return NextResponse.json(
      { error: 'Failed to serve recording screenshot' },
      { status: 500 }
    );
  }
}