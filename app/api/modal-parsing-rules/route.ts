import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const domain = searchParams.get('domain');
    
    const rulesDir = path.join(process.cwd(), 'modal-parsing-rules');
    
    // Ensure rules directory exists
    try {
      await fs.access(rulesDir);
    } catch (error) {
      await fs.mkdir(rulesDir, { recursive: true });
    }

    if (domain) {
      // Get rules for specific domain
      const rulesFile = path.join(rulesDir, `${domain}.json`);
      
      try {
        const rulesContent = await fs.readFile(rulesFile, 'utf-8');
        const rules = JSON.parse(rulesContent);
        
        return NextResponse.json({
          success: true,
          domain: domain,
          rules: rules
        });
      } catch (error) {
        return NextResponse.json({
          success: false,
          domain: domain,
          error: 'No rules found for this domain',
          rules: null
        });
      }
    } else {
      // List all available domains with rules
      try {
        const files = await fs.readdir(rulesDir);
        const ruleFiles = files.filter(file => file.endsWith('.json'));
        
        const allRules = [];
        
        for (const file of ruleFiles) {
          try {
            const filePath = path.join(rulesDir, file);
            const content = await fs.readFile(filePath, 'utf-8');
            const rules = JSON.parse(content);
            
            allRules.push({
              domain: rules.domain || file.replace('.json', ''),
              rulesCount: rules.rules?.length || 0,
              lastUpdated: rules.lastUpdated,
              version: rules.version || 1,
              fileName: file
            });
          } catch (error) {
            console.error(`Error reading rules file ${file}:`, error);
          }
        }
        
        return NextResponse.json({
          success: true,
          totalDomains: allRules.length,
          domains: allRules.sort((a, b) => new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime())
        });
        
      } catch (error) {
        return NextResponse.json({
          success: true,
          totalDomains: 0,
          domains: [],
          message: 'No parsing rules directory found'
        });
      }
    }

  } catch (error) {
    console.error('Modal parsing rules API error:', error);
    return NextResponse.json(
      { error: 'Failed to retrieve parsing rules', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const domain = searchParams.get('domain');
    
    if (!domain) {
      return NextResponse.json(
        { error: 'Domain parameter is required' },
        { status: 400 }
      );
    }

    const rulesDir = path.join(process.cwd(), 'modal-parsing-rules');
    const rulesFile = path.join(rulesDir, `${domain}.json`);
    
    try {
      await fs.unlink(rulesFile);
      return NextResponse.json({
        success: true,
        message: `Parsing rules for ${domain} deleted successfully`
      });
    } catch (error) {
      return NextResponse.json(
        { error: `No parsing rules found for domain: ${domain}` },
        { status: 404 }
      );
    }

  } catch (error) {
    console.error('Modal parsing rules deletion error:', error);
    return NextResponse.json(
      { error: 'Failed to delete parsing rules', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const { domain, rules } = await request.json();
    
    if (!domain || !rules) {
      return NextResponse.json(
        { error: 'Domain and rules are required' },
        { status: 400 }
      );
    }

    const rulesDir = path.join(process.cwd(), 'modal-parsing-rules');
    await fs.mkdir(rulesDir, { recursive: true });
    
    const rulesFile = path.join(rulesDir, `${domain}.json`);
    
    // Add metadata if not present
    const enhancedRules = {
      domain: domain,
      lastUpdated: new Date().toISOString(),
      version: (rules.version || 0) + 1,
      ...rules
    };
    
    await fs.writeFile(rulesFile, JSON.stringify(enhancedRules, null, 2));
    
    return NextResponse.json({
      success: true,
      message: `Parsing rules for ${domain} saved successfully`,
      rulesCount: enhancedRules.rules?.length || 0
    });

  } catch (error) {
    console.error('Modal parsing rules save error:', error);
    return NextResponse.json(
      { error: 'Failed to save parsing rules', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}