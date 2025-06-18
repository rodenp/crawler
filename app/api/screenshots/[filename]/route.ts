import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) {
  try {
    const { filename } = await params;
    const screenshotsDir = path.join(process.cwd(), 'screenshots');
    const filePath = path.join(screenshotsDir, filename);

    // Security check: ensure filename doesn't contain path traversal
    if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return NextResponse.json({ error: 'Invalid filename' }, { status: 400 });
    }

    // Check if file exists
    try {
      await fs.access(filePath);
    } catch {
      return NextResponse.json({ error: 'Screenshot not found' }, { status: 404 });
    }

    // Read and return the file
    const imageBuffer = await fs.readFile(filePath);
    
    return new NextResponse(imageBuffer, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
      },
    });

  } catch (error) {
    console.error('Screenshot serving error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}