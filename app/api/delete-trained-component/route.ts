import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

export async function GET() {
  return NextResponse.json({ message: 'Delete API endpoint is working', method: 'GET' });
}

export async function POST(request: NextRequest) {
  try {
    const { componentId, domain } = await request.json();
    
    if (!componentId || !domain) {
      return NextResponse.json(
        { error: 'Component ID and domain are required' },
        { status: 400 }
      );
    }

    console.log('[DELETE API] Deleting component:', componentId, 'from domain:', domain);

    const rulesFile = path.join(process.cwd(), 'modal-parsing-rules', `${domain}.json`);
    
    try {
      const rulesContent = await fs.readFile(rulesFile, 'utf-8');
      const siteRules = JSON.parse(rulesContent);
      
      // Find and remove the component
      const originalLength = siteRules.trainedComponents?.length || 0;
      siteRules.trainedComponents = (siteRules.trainedComponents || []).filter(
        (comp: any) => comp.id !== componentId
      );
      
      if (siteRules.trainedComponents.length < originalLength) {
        // Component was found and removed
        siteRules.lastUpdated = new Date().toISOString();
        siteRules.version = (siteRules.version || 0) + 1;
        
        await fs.writeFile(rulesFile, JSON.stringify(siteRules, null, 2));
        
        console.log(`[DELETE API] Successfully deleted component: ${componentId}`);
        return NextResponse.json({
          success: true,
          message: `Component ${componentId} deleted successfully`
        });
      } else {
        console.log(`[DELETE API] Component not found: ${componentId}`);
        return NextResponse.json(
          { error: 'Component not found' },
          { status: 404 }
        );
      }
      
    } catch (fileError) {
      console.error('[DELETE API] File error:', fileError);
      return NextResponse.json(
        { error: 'Domain rules file not found' },
        { status: 404 }
      );
    }

  } catch (error) {
    console.error('[DELETE API] Delete trained component error:', error);
    return NextResponse.json(
      { error: 'Failed to delete trained component', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}