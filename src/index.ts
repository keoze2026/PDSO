// src/index.ts
import express from 'express';
import { Telegraf, Context } from 'telegraf';
import axios from 'axios';
import pLimit from 'p-limit';

// Configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8067862927:AAF15wt-h8YGfXhtdN0kOXu3MQf-zGX0gWU';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const PORT = parseInt(process.env.PORT || '8080');
const BASE_API = 'https://api-gateway.dialics.com/api/v1';

// Workspace configurations
const WORKSPACES = [
  {
    name: 'Workspace 1',
    workspace: 'aq2O7TXNfZl7H6kjhm2LEw8OI2rJwLwD',
    token: '463907|nVI45fhW3Dq12lUTLUWwRQyeu2Iy1Z078lHSwbIxtD2H4g0LxVjax6gj0b6kEwbVnfJjYpiHSVcXMeCyXF8rgI8OzHA2PzfmntTNZYbsIhGOmCfdlzafKSGmja479fmsf8TK0jxOhM4dKDUOR2vGE44fmInqfFUvdba0WgfgXwWJVn9YjD6TGfLGTIXnTjUTDK0ynOIYXNX65KqgvjfEuvfuiuleW6LedDjR0DeowL4lKFQkZbWfOgqwa8cmqO8u'
  },
  {
    name: 'Workspace 2',
    workspace: '08tMnbNzs66wzR6yVGf8LmabJwDQqrWq',
    token: '469458|Q7EX5xHoFzB3reLeBiyzwOm9GU1L1v8XSnVJmuIazoTw6DkKCwE8ff6mjVBr1hux8ru4zBAlRPniQBpHPvqrtR9NKat8SIP7hQpOrjk78kd3WU51aSgraIH2lBxUDYf9NTu2sPDcTDdsfbp0MR9gDXmo2VQoREnNqUk1ODsIkHbCNquG8uj1ufRH61SCdTR9kI75QI5qfo9iWKWzUd9201OLDrN5HeUDT4lsC4AKCAUGJ1RVj6GyIdsoi9nlVcau'
  }
];

// Campaigns to exclude from all statistics and reports
const EXCLUDED_CAMPAIGNS = [
  '11 Camp Ext'
];

// Types
interface WorkspaceConfig {
  name: string;
  workspace: string;
  token: string;
}

interface UserSession {
  date: string;
  // Key format: "commandName-chatId" to isolate autoruns per channel
  autorunJobs: Map<string, { interval: NodeJS.Timeout; chatId: number; commandName: string }>;
  // Processing flag per chat to prevent concurrent requests in same channel
  processing: Map<number, boolean>;
  cachedCalls?: { data: CallData[]; timestamp: number; date: string };
}

interface CallData {
  uuid?: string;
  campaign?: { name?: string };
  live?: number;
  queued?: number;
  duration?: number;
  status?: { name?: string };
  vendor_status?: { name?: string };
  called_number?: string;
  caller_number?: string;
}

interface TFNStats {
  tfn: string;
  liveCount: number;
  totalDuration: number;
  connectedCount: number;
  aht: number;
}

interface CampaignStats {
  name: string;
  live: number;
  incoming: number;
  connected: number;
  totalDuration: number;
  aht: number;
  tfns: Map<string, TFNStats>;
}

interface ApiResponse {
  success?: boolean;
  payload?: {
    data?: CallData[];
    current_page?: number;
    last_page?: number;
  };
}

interface WorkspaceFetchResult {
  workspaceName: string;
  calls: CallData[];
  success: boolean;
  error?: string;
}

// User sessions storage
const userSessions = new Map<number, UserSession>();

// Initialize bot
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const app = express();

// Middleware
app.use(express.json());

// Helper functions
const getCurrentDate = (): string => {
  return new Date().toISOString().split('T')[0];
};

const getOrCreateSession = (userId: number): UserSession => {
  if (!userSessions.has(userId)) {
    userSessions.set(userId, {
      date: getCurrentDate(),
      autorunJobs: new Map(),
      processing: new Map(),
    });
  }
  return userSessions.get(userId)!;
};

const buildUrl = (workspace: string, endpoint: string): string => {
  return `${BASE_API}/${workspace}/${endpoint.replace(/^\//, '')}`;
};

const apiGet = async (workspace: string, token: string, endpoint: string, params: Record<string, any> = {}): Promise<any> => {
  const url = buildUrl(workspace, endpoint);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };

  try {
    const response = await axios.get(url, { headers, params, timeout: 30000 });
    return response.data;
  } catch (error: any) {
    console.error(`API Error: ${error.message}`);
    throw new Error(`API request failed: ${error.message}`);
  }
};

const buildParamsWithDate = (date: string, extra: Record<string, any> = {}): Record<string, any> => {
  return {
    date,
    dateTo: date,
    timezone: '21',
    ...extra,
  };
};

const fetchAllCallsFromSingleWorkspace = async (
  workspaceName: string,
  workspace: string,
  token: string,
  date: string
): Promise<WorkspaceFetchResult> => {
  try {
    const allCalls: CallData[] = [];
    const seenUuids = new Set<string>();
    
    // Fetch first page to get total pages
    const firstParams = buildParamsWithDate(date, { page: 1, perPage: 100 });
    const firstResponse: ApiResponse = await apiGet(workspace, token, 'calls/log', firstParams);
    
    if (!firstResponse.success || !firstResponse.payload?.data) {
      console.warn(`[${workspaceName}] Unexpected response format`);
      return { workspaceName, calls: [], success: false, error: 'Unexpected response format' };
    }
    
    // Add calls from first page with UUID tracking
    firstResponse.payload.data.forEach(call => {
      const uuid = call.uuid;
      if (uuid && !seenUuids.has(uuid)) {
        seenUuids.add(uuid);
        allCalls.push(call);
      } else if (!uuid) {
        allCalls.push(call);
      }
    });
    
    const lastPage = firstResponse.payload.last_page || 1;
    console.log(`[${workspaceName}] Fetched page 1/${lastPage}: ${firstResponse.payload.data.length} calls`);
    
    if (lastPage <= 1) {
      console.log(`[${workspaceName}] Total calls fetched: ${allCalls.length} (single page)`);
      return { workspaceName, calls: allCalls, success: true };
    }
    
    // SPEED OPTIMIZATION: Increased concurrency to 35 for faster parallel fetching
    const limit = pLimit(35);
    const pagePromises: Promise<CallData[]>[] = [];
    
    for (let page = 2; page <= lastPage; page++) {
      pagePromises.push(
        limit(async () => {
          try {
            const params = buildParamsWithDate(date, { page, perPage: 100 });
            const response: ApiResponse = await apiGet(workspace, token, 'calls/log', params);
            
            if (response.success && response.payload?.data) {
              console.log(`[${workspaceName}] Fetched page ${page}/${lastPage}: ${response.payload.data.length} calls`);
              return response.payload.data;
            }
            return [];
          } catch (error) {
            console.error(`[${workspaceName}] Error fetching page ${page}:`, error);
            return [];
          }
        })
      );
    }
    
    const results = await Promise.all(pagePromises);
    
    // SPEED OPTIMIZATION: Single-pass deduplication for better performance
    results.forEach(pageData => {
      pageData.forEach(call => {
        const uuid = call.uuid;
        if (uuid && !seenUuids.has(uuid)) {
          seenUuids.add(uuid);
          allCalls.push(call);
        } else if (!uuid) {
          allCalls.push(call);
        }
      });
    });
    
    console.log(`[${workspaceName}] Total calls fetched: ${allCalls.length} across ${lastPage} pages (unique: ${seenUuids.size})`);
    return { workspaceName, calls: allCalls, success: true };
    
  } catch (error: any) {
    console.error(`[${workspaceName}] Error fetching calls:`, error);
    return { workspaceName, calls: [], success: false, error: error.message };
  }
};

const fetchAllCallsFromMultipleWorkspaces = async (
  workspaceConfigs: WorkspaceConfig[],
  date: string,
  useCache: boolean = false,
  session?: UserSession
): Promise<CallData[]> => {
  // Check cache if enabled and session provided
  if (useCache && session?.cachedCalls && session.cachedCalls.date === date) {
    const cacheAge = Date.now() - session.cachedCalls.timestamp;
    // Cache valid for 2 minutes
    if (cacheAge < 120000) {
      console.log('Using cached calls data');
      return session.cachedCalls.data;
    }
  }

  console.log(`Fetching calls from ${workspaceConfigs.length} workspaces in parallel...`);
  
  // Fetch from all workspaces in parallel
  const fetchPromises = workspaceConfigs.map(config =>
    fetchAllCallsFromSingleWorkspace(config.name, config.workspace, config.token, date)
  );
  
  const results = await Promise.all(fetchPromises);
  
  // Log results from each workspace
  const successfulWorkspaces: string[] = [];
  const failedWorkspaces: string[] = [];
  
  results.forEach(result => {
    if (result.success) {
      successfulWorkspaces.push(`${result.workspaceName} (${result.calls.length} calls)`);
    } else {
      failedWorkspaces.push(`${result.workspaceName} (${result.error || 'unknown error'})`);
    }
  });
  
  if (successfulWorkspaces.length > 0) {
    console.log(`✓ Successful fetches: ${successfulWorkspaces.join(', ')}`);
  }
  
  if (failedWorkspaces.length > 0) {
    console.warn(`✗ Failed fetches: ${failedWorkspaces.join(', ')}`);
  }
  
  // SPEED OPTIMIZATION: Pre-allocate array size and use single-pass deduplication
  const allCalls: CallData[] = [];
  const globalSeenUuids = new Set<string>();
  
  results.forEach(result => {
    if (result.success) {
      result.calls.forEach(call => {
        const uuid = call.uuid;
        if (uuid && !globalSeenUuids.has(uuid)) {
          globalSeenUuids.add(uuid);
          allCalls.push(call);
        } else if (!uuid) {
          allCalls.push(call);
        }
      });
    }
  });
  
  console.log(`Total merged calls: ${allCalls.length} (unique across all workspaces)`);
  
  // Cache the result
  if (session) {
    session.cachedCalls = { data: allCalls, timestamp: Date.now(), date };
  }
  
  return allCalls;
};

const isCallConnected = (call: CallData): boolean => {
  const duration = call.duration || 0;
  const statusName = call.status?.name?.toLowerCase() || '';
  const vendorStatusName = call.vendor_status?.name?.toLowerCase() || '';
  
  // A call is connected if:
  // 1. Status contains "completed" (regardless of duration), OR
  // 2. Vendor status contains "completed", OR
  // 3. Duration > 0 AND status is NOT "call not connected"
  const hasCompletedStatus = statusName.includes('completed') || vendorStatusName.includes('completed');
  const hasDurationAndNotFailed = duration > 0 && !statusName.includes('not connected');
  
  return hasCompletedStatus || hasDurationAndNotFailed;
};

const calculateCampaignStats = (calls: CallData[]): Map<string, CampaignStats> => {
  const stats = new Map<string, CampaignStats>();
  
  for (const call of calls) {
    const campaignName = call.campaign?.name || 'Unknown Campaign';
    
    // Skip excluded campaigns
    if (EXCLUDED_CAMPAIGNS.includes(campaignName)) {
      continue;
    }
    
    if (!stats.has(campaignName)) {
      stats.set(campaignName, {
        name: campaignName,
        live: 0,
        incoming: 0,
        connected: 0,
        totalDuration: 0,
        aht: 0,
        tfns: new Map(),
      });
    }
    
    const campaignStats = stats.get(campaignName)!;
    const isLive = call.live === 1;
    const isQueued = call.queued === 1;
    const duration = call.duration || 0;
    const tfn = call.called_number || 'Unknown';
    
    // Initialize TFN stats if not exists
    if (!campaignStats.tfns.has(tfn)) {
      campaignStats.tfns.set(tfn, { tfn, liveCount: 0, totalDuration: 0, connectedCount: 0, aht: 0 });
    }
    
    // Track TFN live calls
    if (isLive) {
      campaignStats.tfns.get(tfn)!.liveCount++;
      campaignStats.live++;
    }
    
    if (isQueued) {
      campaignStats.incoming++;
    }
    
    // Check if call is connected
    const isConnected = isCallConnected(call);
    
    if (isConnected) {
      campaignStats.connected++;
      
      // Only add duration if > 0 (for AHT calculation)
      if (duration > 0) {
        campaignStats.totalDuration += duration;
      }
      
      // Track TFN duration and connected count
      const tfnStats = campaignStats.tfns.get(tfn)!;
      tfnStats.connectedCount++;
      
      if (duration > 0) {
        tfnStats.totalDuration += duration;
      }
    }
  }
  
  // Calculate AHT for campaigns and TFNs
  stats.forEach(s => {
    if (s.connected > 0) {
      s.aht = s.totalDuration / s.connected;
    }
    
    // Calculate AHT for each TFN
    s.tfns.forEach(tfnStats => {
      if (tfnStats.connectedCount > 0) {
        tfnStats.aht = tfnStats.totalDuration / tfnStats.connectedCount;
      }
    });
  });
  
  return stats;
};

const formatDuration = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

const extractCampaignNumber = (campaignName: string): string => {
  // Check if campaign name matches pattern "Camp XX" or "Campaign XX" (where XX is a number)
  // If so, extract just the number. Otherwise, return the full campaign name.
  const campPattern = /^Camp(?:aign)?\s+(\d+)$/i;
  const match = campaignName.match(campPattern);
  
  if (match) {
    // Return just the number for "Camp 01" -> "01" format
    return match[1];
  }
  
  // For other formats like "PDSO 02", return the full name
  return campaignName;
};

const formatCampaignStats = (stats: Map<string, CampaignStats>, date: string): string => {
  if (stats.size === 0) return 'No campaigns currently active.';
  
  let text = `Campaign Stats (${date})\n\n`;
  
  const sortedStats = Array.from(stats.values()).sort((a, b) => a.name.localeCompare(b.name));
  
  sortedStats.forEach((s, index) => {
    const campaignDisplay = extractCampaignNumber(s.name);
    text += `Campaign: ${campaignDisplay}\n\n`;
    text += `∙ Live: ${s.live}\n`;
    text += `∙ Connected: ${s.connected}\n`;
    text += `∙ Connected AHT: ${formatDuration(s.aht)}\n`;
    
    // Add separator line if not the last campaign
    if (index < sortedStats.length - 1) {
      text += `\n--------------------------------                           \n\n`;
    }
  });
  
  return text.trim();
};

const formatTFNStats = (stats: Map<string, CampaignStats>, date: string): string => {
  if (stats.size === 0) return 'No campaigns currently active.';
  
  let text = `Campaign TFN Stats (${date})\n\n`;
  
  const sortedStats = Array.from(stats.values()).sort((a, b) => a.name.localeCompare(b.name));
  
  sortedStats.forEach((s, index) => {
    const campaignDisplay = extractCampaignNumber(s.name);
    text += `Campaign: ${campaignDisplay}\n\n`;
    
    // Sort TFNs by connected calls in descending order (highest first)
    const sortedTfns = Array.from(s.tfns.values())
      .filter(tfn => tfn.connectedCount > 0)
      .sort((a, b) => b.connectedCount - a.connectedCount);
    
    if (sortedTfns.length > 0) {
      text += `∙ TFNs:\n`;
      
      // Find the maximum TFN length and count length for alignment
      const maxTfnLength = Math.max(...sortedTfns.map(tfn => tfn.tfn.length));
      const maxCountLength = Math.max(...sortedTfns.map(tfn => tfn.connectedCount.toString().length));
      
      // Use pre-formatted block for monospace
      text += '<pre>';
      
      sortedTfns.forEach(tfn => {
        const tfnPadded = tfn.tfn.padEnd(maxTfnLength);
        const countStr = tfn.connectedCount.toString();
        const countPadded = countStr.padStart(maxCountLength);
        
        text += `  ${tfnPadded}: ${countPadded}    (AHT: ${formatDuration(tfn.aht)})\n`;
      });
      
      text += '</pre>\n';
    }
    
    text += `∙ Live: ${s.live}\n`;
    text += `∙ Connected: ${s.connected}\n`;
    text += `∙ Connected AHT: ${formatDuration(s.aht)}\n`;
    
    // Add separator line if not the last campaign
    if (index < sortedStats.length - 1) {
      text += `\n--------------------------------                           \n\n`;
    }
  });
  
  return text.trim();
};

const calculateTotalFlow = (stats: Map<string, CampaignStats>): number => {
  let total = 0;
  stats.forEach(s => {
    total += s.live;
  });
  return total;
};

const getRepeatCallers = (calls: CallData[]): Map<string, Map<string, number>> => {
  // Map: campaign -> caller_number -> call count
  const callerCounts = new Map<string, Map<string, number>>();
  
  for (const call of calls) {
    const campaignName = call.campaign?.name || 'Unknown Campaign';
    const callerNumber = call.caller_number || 'Unknown';
    
    // Skip excluded campaigns
    if (EXCLUDED_CAMPAIGNS.includes(campaignName)) {
      continue;
    }
    
    // Only count connected calls
    if (!isCallConnected(call)) {
      continue;
    }
    
    if (!callerCounts.has(campaignName)) {
      callerCounts.set(campaignName, new Map());
    }
    
    const campaignCallers = callerCounts.get(campaignName)!;
    campaignCallers.set(callerNumber, (campaignCallers.get(callerNumber) || 0) + 1);
  }
  
  return callerCounts;
};

const formatRepeatCallers = (callerCounts: Map<string, Map<string, number>>, date: string): string => {
  let text = `IVR Repeat Callers (${date})\n\n`;
  
  const sortedCampaigns = Array.from(callerCounts.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  let foundAny = false;
  
  sortedCampaigns.forEach(([campaignName, callers], campaignIndex) => {
    // Filter callers with more than 3 calls
    const repeatCallers = Array.from(callers.entries())
      .filter(([_, count]) => count > 3)
      .sort((a, b) => b[1] - a[1]); // Sort by count descending
    
    if (repeatCallers.length > 0) {
      foundAny = true;
      const campaignDisplay = extractCampaignNumber(campaignName);
      text += `Campaign: ${campaignDisplay}\n\n`;
      
      repeatCallers.forEach(([callerNumber, count]) => {
        text += `∙ ${callerNumber}: ${count} calls\n`;
      });
      
      // Add separator if not last campaign with data
      const remainingCampaigns = sortedCampaigns.slice(campaignIndex + 1);
      const hasMoreWithData = remainingCampaigns.some(([_, callers]) => 
        Array.from(callers.values()).some(count => count > 3)
      );
      
      if (hasMoreWithData) {
        text += `\n--------------------------------                           \n\n`;
      }
    }
  });
  
  if (!foundAny) {
    return `IVR Repeat Callers (${date})\n\nNo callers with more than 3 calls found.`;
  }
  
  return text.trim();
};

const getChatId = (ctx: Context): number => {
  return ctx.chat!.id;
};

// Helper function to create job key (command-chatId)
const createJobKey = (commandName: string, chatId: number): string => {
  return `${commandName}-${chatId}`;
};

// Helper function to check if chat is processing
const isChatProcessing = (session: UserSession, chatId: number): boolean => {
  return session.processing.get(chatId) || false;
};

// Helper function to set chat processing state
const setChatProcessing = (session: UserSession, chatId: number, state: boolean): void => {
  session.processing.set(chatId, state);
};

// Bot commands
bot.command('start', async (ctx) => {
  const userId = ctx.from!.id;
  const session = getOrCreateSession(userId);
  
  await ctx.reply(
    `*Welcome to the Campaign Stats Bot!*\n\n` +
    `*Current Date:* ${session.date}\n` +
    `*Workspaces:* ${WORKSPACES.length} workspaces configured\n\n` +
    `*Statistics:*\n` +
    `/stats [start INTERVAL] — View campaign statistics\n` +
    `/viewtfns [start INTERVAL] — View TFN-specific statistics with AHT\n` +
    `/getivr [start INTERVAL] — View repeat callers (>3 calls)\n` +
    `/flow [start INTERVAL] — Check total flow and alert if below 60\n` +
    `/stopauto — Stop all autoruns in this channel\n\n` +
    `*Configuration:*\n` +
    `/changedate — Change the date filter\n` +
    `/clear — Clear your session data\n\n` +
    `*Examples:*\n` +
    `\`/stats\` — View current campaign stats\n` +
    `\`/stats start 5\` — Auto-check stats every 5 minutes\n` +
    `\`/viewtfns start 10\` — Auto-check TFN stats every 10 minutes\n` +
    `\`/getivr start 15\` — Auto-check repeat callers every 15 minutes\n` +
    `\`/flow start 3\` — Auto-check flow every 3 minutes\n\n` +
    `*Note:* The bot fetches data from multiple workspaces simultaneously for faster results. Each channel has independent autoruns. By default, it uses today's date. Use /changedate to analyze a different date.`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('help', async (ctx) => {
  const userId = ctx.from!.id;
  const session = getOrCreateSession(userId);
  
  await ctx.reply(
    `*Campaign Stats Bot Help*\n\n` +
    `*Current Date:* ${session.date}\n` +
    `*Workspaces:* ${WORKSPACES.length} workspaces configured\n\n` +
    `*Statistics:*\n` +
    `/stats [start INTERVAL] — View campaign statistics\n` +
    `/viewtfns [start INTERVAL] — View TFN-specific statistics with AHT\n` +
    `/getivr [start INTERVAL] — View repeat callers (>3 calls)\n` +
    `/flow [start INTERVAL] — Check total flow and alert if below 60\n` +
    `/stopauto — Stop all autoruns in this channel\n\n` +
    `*Configuration:*\n` +
    `/changedate — Change the date filter\n` +
    `/clear — Clear your session data\n\n` +
    `*Examples:*\n` +
    `\`/stats\` — View current campaign stats\n` +
    `\`/stats start 5\` — Auto-check stats every 5 minutes\n` +
    `\`/viewtfns start 10\` — Auto-check TFN stats every 10 minutes\n` +
    `\`/getivr start 15\` — Auto-check repeat callers every 15 minutes\n` +
    `\`/flow start 3\` — Auto-check flow every 3 minutes\n\n` +
    `*Note:* The bot fetches data from multiple workspaces simultaneously. Each channel has independent autoruns. By default, it uses today's date. Use /changedate to analyze a different date.`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('stats', async (ctx) => {
  const userId = ctx.from!.id;
  const chatId = getChatId(ctx);
  const session = getOrCreateSession(userId);
  
  if (isChatProcessing(session, chatId)) {
    return ctx.reply('Please wait, your previous request is still processing...');
  }
  
  setChatProcessing(session, chatId, true);
  
  try {
    const args = ctx.message!.text.split(' ').slice(1);
    
    if (args[0] === 'start') {
      const interval = Math.max(parseInt(args[1]) || 5, 1);
      const jobKey = createJobKey('stats', chatId);
      
      // Stop existing autorun for this command in this channel
      const existingJob = session.autorunJobs.get(jobKey);
      if (existingJob) {
        clearInterval(existingJob.interval);
      }
      
      // Execute immediately (without cache for fresh data)
      await ctx.reply('Fetching statistics from all workspaces...');
      const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, false, session);
      const stats = calculateCampaignStats(calls);
      const text = formatCampaignStats(stats, session.date);
      await ctx.reply(text, { parse_mode: 'Markdown' });
      
      // Schedule repeating job
      const job = setInterval(async () => {
        try {
          const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, false, session);
          const stats = calculateCampaignStats(calls);
          const text = formatCampaignStats(stats, session.date);
          await ctx.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown' });
        } catch (error: any) {
          console.error('Autorun stats error:', error);
        }
      }, interval * 60 * 1000);
      
      session.autorunJobs.set(jobKey, { interval: job, chatId, commandName: 'stats' });
      await ctx.reply(`Statistics autorun started (every ${interval} minutes) for date: ${session.date}\nThis autorun is specific to this channel.`);
    } else {
      // One-time stats (without cache for fresh data)
      await ctx.reply('Fetching statistics from all workspaces...');
      const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, false, session);
      const stats = calculateCampaignStats(calls);
      const text = formatCampaignStats(stats, session.date);
      await ctx.reply(text, { parse_mode: 'Markdown' });
    }
  } catch (error: any) {
    await ctx.reply(`Error fetching stats: ${error.message}`);
  } finally {
    setChatProcessing(session, chatId, false);
  }
});

bot.command('viewtfns', async (ctx) => {
  const userId = ctx.from!.id;
  const chatId = getChatId(ctx);
  const session = getOrCreateSession(userId);
  
  if (isChatProcessing(session, chatId)) {
    return ctx.reply('Please wait, your previous request is still processing...');
  }
  
  setChatProcessing(session, chatId, true);
  
  try {
    const args = ctx.message!.text.split(' ').slice(1);
    
    if (args[0] === 'start') {
      const interval = Math.max(parseInt(args[1]) || 5, 1);
      const jobKey = createJobKey('viewtfns', chatId);
      
      // Stop existing autorun for this command in this channel
      const existingJob = session.autorunJobs.get(jobKey);
      if (existingJob) {
        clearInterval(existingJob.interval);
      }
      
      // Execute immediately (without cache for fresh data)
      await ctx.reply('Fetching TFN statistics from all workspaces...');
      const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, false, session);
      const stats = calculateCampaignStats(calls);
      const text = formatTFNStats(stats, session.date);
      await ctx.reply(text, { parse_mode: 'HTML' });
      
      // Schedule repeating job
      const job = setInterval(async () => {
        try {
          const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, false, session);
          const stats = calculateCampaignStats(calls);
          const text = formatTFNStats(stats, session.date);
          await ctx.telegram.sendMessage(chatId, text, { parse_mode: 'HTML' });
        } catch (error: any) {
          console.error('Autorun viewtfns error:', error);
        }
      }, interval * 60 * 1000);
      
      session.autorunJobs.set(jobKey, { interval: job, chatId, commandName: 'viewtfns' });
      await ctx.reply(`TFN statistics autorun started (every ${interval} minutes) for date: ${session.date}\nThis autorun is specific to this channel.`);
    } else {
      // One-time TFN stats (without cache for fresh data)
      await ctx.reply('Fetching TFN statistics from all workspaces...');
      const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, false, session);
      const stats = calculateCampaignStats(calls);
      const text = formatTFNStats(stats, session.date);
      await ctx.reply(text, { parse_mode: 'HTML' });
    }
  } catch (error: any) {
    await ctx.reply(`Error fetching TFN stats: ${error.message}`);
  } finally {
    setChatProcessing(session, chatId, false);
  }
});

bot.command('getivr', async (ctx) => {
  const userId = ctx.from!.id;
  const chatId = getChatId(ctx);
  const session = getOrCreateSession(userId);
  
  if (isChatProcessing(session, chatId)) {
    return ctx.reply('Please wait, your previous request is still processing...');
  }
  
  setChatProcessing(session, chatId, true);
  
  try {
    const args = ctx.message!.text.split(' ').slice(1);
    
    if (args[0] === 'start') {
      const interval = Math.max(parseInt(args[1]) || 15, 1);
      const jobKey = createJobKey('getivr', chatId);
      
      // Stop existing autorun for this command in this channel
      const existingJob = session.autorunJobs.get(jobKey);
      if (existingJob) {
        clearInterval(existingJob.interval);
      }
      
      // Execute immediately (without cache for fresh data)
      await ctx.reply('Fetching repeat callers from all workspaces...');
      const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, false, session);
      const callerCounts = getRepeatCallers(calls);
      const text = formatRepeatCallers(callerCounts, session.date);
      await ctx.reply(text, { parse_mode: 'Markdown' });
      
      // Schedule repeating job
      const job = setInterval(async () => {
        try {
          const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, false, session);
          const callerCounts = getRepeatCallers(calls);
          const text = formatRepeatCallers(callerCounts, session.date);
          await ctx.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown' });
        } catch (error: any) {
          console.error('Autorun getivr error:', error);
        }
      }, interval * 60 * 1000);
      
      session.autorunJobs.set(jobKey, { interval: job, chatId, commandName: 'getivr' });
      await ctx.reply(`Repeat callers autorun started (every ${interval} minutes) for date: ${session.date}\nThis autorun is specific to this channel.`);
    } else {
      // One-time repeat callers check (without cache for fresh data)
      await ctx.reply('Fetching repeat callers from all workspaces...');
      const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, false, session);
      const callerCounts = getRepeatCallers(calls);
      const text = formatRepeatCallers(callerCounts, session.date);
      await ctx.reply(text, { parse_mode: 'Markdown' });
    }
  } catch (error: any) {
    await ctx.reply(`Error fetching repeat callers: ${error.message}`);
  } finally {
    setChatProcessing(session, chatId, false);
  }
});

bot.command('flow', async (ctx) => {
  const userId = ctx.from!.id;
  const chatId = getChatId(ctx);
  const session = getOrCreateSession(userId);
  
  if (isChatProcessing(session, chatId)) {
    return ctx.reply('Please wait, your previous request is still processing...');
  }
  
  setChatProcessing(session, chatId, true);
  
  try {
    const args = ctx.message!.text.split(' ').slice(1);
    
    if (args[0] === 'start') {
      const interval = Math.max(parseInt(args[1]) || 5, 1);
      const jobKey = createJobKey('flow', chatId);
      
      // Stop existing autorun for this command in this channel
      const existingJob = session.autorunJobs.get(jobKey);
      if (existingJob) {
        clearInterval(existingJob.interval);
      }
      
      // Execute immediately (without cache for fresh data)
      await ctx.reply('Checking flow from all workspaces...');
      const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, false, session);
      const stats = calculateCampaignStats(calls);
      const totalFlow = calculateTotalFlow(stats);
      
      let text = `Flow Check (${session.date})\n\n`;
      text += 'Campaign Breakdown:\n';
      const sortedStats = Array.from(stats.values()).sort((a, b) => a.name.localeCompare(b.name));
      sortedStats.forEach(s => {
        text += `• ${s.name}: ${s.live}\n`;
      });
      
      text += `\nTotal Flow: ${totalFlow} (Live)\n`;
      
      if (totalFlow < 60) {
        text += 'ALERT: Low flow, dial kindly';
      }
      
      await ctx.reply(text);
      
      // Schedule repeating job
      const job = setInterval(async () => {
        try {
          const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, false, session);
          const stats = calculateCampaignStats(calls);
          const totalFlow = calculateTotalFlow(stats);
          
          let text = `Flow Check (${session.date})\n\n`;
          text += 'Campaign Breakdown:\n';
          const sortedStats = Array.from(stats.values()).sort((a, b) => a.name.localeCompare(b.name));
          sortedStats.forEach(s => {
            text += `• ${s.name}: ${s.live}\n`;
          });
          
          text += `\nTotal Flow: ${totalFlow} (Live)\n`;
          
          if (totalFlow < 60) {
            text += 'ALERT: Low flow, dial kindly';
          }
          
          await ctx.telegram.sendMessage(chatId, text);
        } catch (error: any) {
          console.error('Autorun flow error:', error);
        }
      }, interval * 60 * 1000);
      
      session.autorunJobs.set(jobKey, { interval: job, chatId, commandName: 'flow' });
      await ctx.reply(`Flow check autorun started (every ${interval} minutes) for date: ${session.date}\nThis autorun is specific to this channel.`);
    } else {
      // One-time flow check (without cache for fresh data)
      await ctx.reply('Checking flow from all workspaces...');
      const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, false, session);
      const stats = calculateCampaignStats(calls);
      const totalFlow = calculateTotalFlow(stats);
      
      let text = `Flow Check (${session.date})\n\n`;
      text += 'Campaign Breakdown:\n';
      const sortedStats = Array.from(stats.values()).sort((a, b) => a.name.localeCompare(b.name));
      sortedStats.forEach(s => {
        text += `• ${s.name}: ${s.live}\n`;
      });
      
      text += `\nTotal Flow: ${totalFlow} (Live)\n`;
      
      if (totalFlow < 60) {
        text += 'ALERT: Low flow, dial kindly';
      }
      
      await ctx.reply(text);
    }
  } catch (error: any) {
    await ctx.reply(`Error checking flow: ${error.message}`);
  } finally {
    setChatProcessing(session, chatId, false);
  }
});

bot.command('changedate', async (ctx) => {
  const userId = ctx.from!.id;
  const session = getOrCreateSession(userId);
  
  await ctx.reply(
    `Current date filter: *${session.date}*\n\n` +
    `Enter a new date to filter calls (format: YYYY-MM-DD)\n` +
    `Example: 2025-11-26\n` +
    `Or send /cancel to keep current date.`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('cancel', async (ctx) => {
  const userId = ctx.from!.id;
  const session = getOrCreateSession(userId);
  await ctx.reply(`Date change cancelled. Current date: *${session.date}*`, { parse_mode: 'Markdown' });
});

bot.command('stopauto', async (ctx) => {
  const userId = ctx.from!.id;
  const chatId = getChatId(ctx);
  const session = getOrCreateSession(userId);
  
  // Find jobs for this specific channel
  const jobsForThisChannel: string[] = [];
  const stoppedCommands: string[] = [];
  
  session.autorunJobs.forEach((job, jobKey) => {
    if (job.chatId === chatId) {
      clearInterval(job.interval);
      jobsForThisChannel.push(jobKey);
      stoppedCommands.push(job.commandName);
    }
  });
  
  // Remove stopped jobs
  jobsForThisChannel.forEach(jobKey => {
    session.autorunJobs.delete(jobKey);
  });
  
  if (stoppedCommands.length === 0) {
    return ctx.reply('No autoruns currently active in this channel.');
  }
  
  await ctx.reply(`Stopped autoruns in this channel: ${stoppedCommands.join(', ')}\n\nAutoruns in other channels remain active.`);
});

bot.command('clear', async (ctx) => {
  const userId = ctx.from!.id;
  const session = userSessions.get(userId);
  
  if (session) {
    session.autorunJobs.forEach(job => clearInterval(job.interval));
    userSessions.delete(userId);
  }
  
  await ctx.reply('Cleared your session data.\nYour next command will automatically use today\'s date.');
});

// Handle date input after /changedate
bot.on('text', async (ctx) => {
  const userId = ctx.from!.id;
  const text = ctx.message.text;
  
  // Check if it's a date format
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (dateRegex.test(text)) {
    const session = getOrCreateSession(userId);
    
    try {
      const date = new Date(text);
      if (isNaN(date.getTime())) {
        return ctx.reply('Invalid date format. Please use YYYY-MM-DD format.\nExample: 2025-11-26');
      }
      
      session.date = text;
      // Clear cache when date changes
      session.cachedCalls = undefined;
      
      await ctx.reply(
        `Date filter updated to: *${text}*\n\n` +
        `Available commands:\n` +
        `• /stats [start INTERVAL] - Campaign statistics\n` +
        `• /viewtfns [start INTERVAL] - View TFN statistics with AHT\n` +
        `• /getivr [start INTERVAL] - View repeat callers\n` +
        `• /flow [start INTERVAL] - Check total flow\n` +
        `• /changedate - Change date filter\n` +
        `• /stopauto - Stop autoruns in this channel\n` +
        `• /help - Show help`,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      await ctx.reply('Invalid date format. Please use YYYY-MM-DD format.\nExample: 2025-11-26');
    }
  }
});

// Express routes
app.get('/', (req, res) => {
  res.send('Bot is running with multi-workspace support and channel-isolated autoruns');
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    workspaces: WORKSPACES.length
  });
});

app.post('/webhook', (req, res) => {
  bot.handleUpdate(req.body);
  res.sendStatus(200);
});

app.get('/webhook_info', async (req, res) => {
  try {
    const info = await bot.telegram.getWebhookInfo();
    res.json(info);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
const startServer = async () => {
  if (!WEBHOOK_URL) {
    console.error('='.repeat(60));
    console.error('CRITICAL: WEBHOOK_URL environment variable is not set!');
    console.error('Please set WEBHOOK_URL to your deployment URL');
    console.error('Example: https://yourapp.render.com');
    console.error('='.repeat(60));
  } else {
    const webhookUrl = `${WEBHOOK_URL}/webhook`;
    await bot.telegram.setWebhook(webhookUrl);
    console.log(`Webhook set to: ${webhookUrl}`);
    
    const info = await bot.telegram.getWebhookInfo();
    console.log('Webhook info:', info);
  }
  
  console.log('='.repeat(60));
  console.log(`Configured workspaces: ${WORKSPACES.length}`);
  WORKSPACES.forEach((ws, index) => {
    console.log(`  ${index + 1}. ${ws.name}: ${ws.workspace}`);
  });
  console.log('Features:');
  console.log('  • Channel-isolated autoruns');
  console.log('  • Speed optimized (35 concurrent requests)');
  console.log('  • Per-channel processing locks');
  console.log('='.repeat(60));
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Default date for new sessions: ${getCurrentDate()}`);
    console.log('Bot is ready to receive updates via webhook');
  });
};

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});