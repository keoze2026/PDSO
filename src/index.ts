// src/index.ts
import express from 'express';
import { Telegraf, Context } from 'telegraf';
import axios from 'axios';
import pLimit from 'p-limit';

// Configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8067862927:AAF15wt-h8YGfXhtdN0kOXu3MQf-zGX0gWU';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://tgbot-nyyq.onrender.com';
const PORT = parseInt(process.env.PORT || '8080');
const BASE_API = 'https://api-gateway.dialics.com/api/v1';

// Hardcoded credentials
const DIALICS_WORKSPACE = 'aq2O7TXNfZl7H6kjhm2LEw8OI2rJwLwD';
const DIALICS_API_TOKEN = '463907|nVI45fhW3Dq12lUTLUWwRQyeu2Iy1Z078lHSwbIxtD2H4g0LxVjax6gj0b6kEwbVnfJjYpiHSVcXMeCyXF8rgI8OzHA2PzfmntTNZYbsIhGOmCfdlzafKSGmja479fmsf8TK0jxOhM4dKDUOR2vGE44fmInqfFUvdba0WgfgXwWJVn9YjD6TGfLGTIXnTjUTDK0ynOIYXNX65KqgvjfEuvfuiuleW6LedDjR0DeowL4lKFQkZbWfOgqwa8cmqO8u';

// Types
interface UserSession {
  workspace: string;
  token: string;
  date: string;
  autorunJobs: Map<string, { interval: NodeJS.Timeout; chatId: number }>;
  processing: boolean;
}

interface CallData {
  campaign?: { name?: string };
  live?: number;
  queued?: number;
  duration?: number;
  status?: { name?: string };
  called_number?: string;
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
      workspace: DIALICS_WORKSPACE,
      token: DIALICS_API_TOKEN,
      date: getCurrentDate(),
      autorunJobs: new Map(),
      processing: false,
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

const fetchAllCalls = async (workspace: string, token: string, date: string): Promise<CallData[]> => {
  const allCalls: CallData[] = [];
  
  // Fetch first page to get total pages
  const firstParams = buildParamsWithDate(date, { page: 1, perPage: 100 });
  const firstResponse: ApiResponse = await apiGet(workspace, token, 'calls/log', firstParams);
  
  if (!firstResponse.success || !firstResponse.payload?.data) {
    console.warn('Unexpected response format');
    return allCalls;
  }
  
  allCalls.push(...firstResponse.payload.data);
  const lastPage = firstResponse.payload.last_page || 1;
  
  console.log(`Fetched page 1/${lastPage}: ${firstResponse.payload.data.length} calls`);
  
  if (lastPage <= 1) {
    console.log(`Total calls fetched: ${allCalls.length} (single page)`);
    return allCalls;
  }
  
  // Fetch remaining pages in parallel with increased concurrency
  const limit = pLimit(15); // Increased from 10 to 15 for faster fetching
  const pagePromises: Promise<CallData[]>[] = [];
  
  for (let page = 2; page <= lastPage; page++) {
    pagePromises.push(
      limit(async () => {
        try {
          const params = buildParamsWithDate(date, { page, perPage: 100 });
          const response: ApiResponse = await apiGet(workspace, token, 'calls/log', params);
          
          if (response.success && response.payload?.data) {
            console.log(`Fetched page ${page}/${lastPage}: ${response.payload.data.length} calls`);
            return response.payload.data;
          }
          return [];
        } catch (error) {
          console.error(`Error fetching page ${page}:`, error);
          return [];
        }
      })
    );
  }
  
  const results = await Promise.all(pagePromises);
  results.forEach(pageData => allCalls.push(...pageData));
  
  console.log(`Total calls fetched: ${allCalls.length} across ${lastPage} pages`);
  return allCalls;
};

const calculateCampaignStats = (calls: CallData[]): Map<string, CampaignStats> => {
  const stats = new Map<string, CampaignStats>();
  
  for (const call of calls) {
    const campaignName = call.campaign?.name || 'Unknown Campaign';
    
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
    const statusName = call.status?.name?.toLowerCase() || '';
    const tfn = call.called_number || 'Unknown';
    
    // Track TFN live calls
    if (isLive && tfn) {
      if (!campaignStats.tfns.has(tfn)) {
        campaignStats.tfns.set(tfn, { tfn, liveCount: 0, totalDuration: 0, connectedCount: 0, aht: 0 });
      }
      campaignStats.tfns.get(tfn)!.liveCount++;
    }
    
    if (isLive) campaignStats.live++;
    if (isQueued) campaignStats.incoming++;
    
    // Connected: All calls with "completed" or "with conversion" in status, OR live calls
    const isConnected = isLive || 
                       statusName.includes('completed') || 
                       statusName.includes('with conversion');
    
    if (isConnected && duration > 0) {
      campaignStats.connected++;
      campaignStats.totalDuration += duration;
      
      // Track TFN duration and connected count for AHT calculation
      if (tfn) {
        if (!campaignStats.tfns.has(tfn)) {
          campaignStats.tfns.set(tfn, { tfn, liveCount: 0, totalDuration: 0, connectedCount: 0, aht: 0 });
        }
        const tfnStats = campaignStats.tfns.get(tfn)!;
        tfnStats.totalDuration += duration;
        tfnStats.connectedCount++;
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

const formatCampaignStats = (stats: Map<string, CampaignStats>, date: string): string => {
  if (stats.size === 0) return 'No campaigns currently active.';
  
  const lines: string[] = [`*Campaign Stats (${date})*\n`];
  const sortedStats = Array.from(stats.values()).sort((a, b) => a.name.localeCompare(b.name));
  
  const formatTime = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };
  
  for (const s of sortedStats) {
    const ahtFormatted = formatTime(s.aht);
    
    let campaignText = `*Campaign => ${s.name}*\n`;
    
    // Add TFNs section with AHT
    if (s.tfns.size > 0) {
      campaignText += `*TFNs:*\n`;
      const sortedTFNs = Array.from(s.tfns.values()).sort((a, b) => b.liveCount - a.liveCount);
      sortedTFNs.forEach(tfn => {
        const tfnAhtFormatted = formatTime(tfn.aht);
        campaignText += `  ${tfn.tfn} - ${tfn.liveCount} (AHT-${tfnAhtFormatted})\n`;
      });
    }
    
    campaignText += `Live => ${s.live}\n`;
    campaignText += `Connected => ${s.connected}\n`;
    campaignText += `AHT => ${ahtFormatted}\n`;
    
    lines.push(campaignText);
  }
  
  return lines.join('\n');
};

const calculateTotalFlow = (stats: Map<string, CampaignStats>): number => {
  let total = 0;
  stats.forEach(s => {
    total += s.live + s.incoming;
  });
  return total;
};

// Get chat ID from context (works for both private and group chats)
const getChatId = (ctx: Context): number => {
  return ctx.chat?.id || ctx.from!.id;
};

// Bot commands
bot.start(async (ctx) => {
  const userId = ctx.from!.id;
  const session = getOrCreateSession(userId);
  
  await ctx.reply(
    `🤖 *Dialics Campaign Statistics Bot*\n\n` +
    `This bot displays real-time campaign statistics including:\n` +
    `• Live calls\n` +
    `• Incoming/queued calls\n` +
    `• Connected calls\n` +
    `• Average handling time (AHT)\n` +
    `• Active TFNs per campaign\n\n` +
    `Currently using date: *${session.date}*\n\n` +
    `You can start using commands immediately!\n` +
    `Use /stats to view campaign statistics.\n` +
    `Use /flow to check total flow.\n` +
    `Use /changedate to filter by a different date.\n` +
    `Use /help to see all available commands.`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('help', async (ctx) => {
  const userId = ctx.from!.id;
  const session = getOrCreateSession(userId);
  
  await ctx.reply(
    `*Available Commands*\n\n` +
    `*Current Date:* ${session.date}\n\n` +
    `*Statistics:*\n` +
    `/stats [start INTERVAL] — View campaign statistics\n` +
    `/flow — Check total flow and alert if below 60\n` +
    `/stopauto — Stop all autoruns\n\n` +
    `*Configuration:*\n` +
    `/changedate — Change the date filter\n` +
    `/clear — Clear your session data\n\n` +
    `*Examples:*\n` +
    `\`/stats\` — View current campaign stats\n` +
    `\`/stats start 5\` — Auto-check stats every 5 minutes\n` +
    `\`/flow\` — Check if total flow is below 60\n\n` +
    `*Note:* By default, the bot uses today's date. Use /changedate to analyze a different date.`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('stats', async (ctx) => {
  const userId = ctx.from!.id;
  const chatId = getChatId(ctx);
  const session = getOrCreateSession(userId);
  
  if (session.processing) {
    return ctx.reply('⏳ Please wait, your previous request is still processing...');
  }
  
  session.processing = true;
  
  try {
    const args = ctx.message!.text.split(' ').slice(1);
    
    if (args[0] === 'start') {
      const interval = Math.max(parseInt(args[1]) || 5, 1);
      
      // Stop existing autorun
      const existingJob = session.autorunJobs.get('stats');
      if (existingJob) {
        clearInterval(existingJob.interval);
      }
      
      // Execute immediately
      await ctx.reply('Fetching statistics...');
      const calls = await fetchAllCalls(session.workspace, session.token, session.date);
      const stats = calculateCampaignStats(calls);
      const text = formatCampaignStats(stats, session.date);
      await ctx.reply(text, { parse_mode: 'Markdown' });
      
      // Schedule repeating job with correct chat ID
      const job = setInterval(async () => {
        try {
          const calls = await fetchAllCalls(session.workspace, session.token, session.date);
          const stats = calculateCampaignStats(calls);
          const text = formatCampaignStats(stats, session.date);
          await ctx.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown' });
        } catch (error: any) {
          console.error('Autorun stats error:', error);
        }
      }, interval * 60 * 1000);
      
      session.autorunJobs.set('stats', { interval: job, chatId });
      await ctx.reply(`✅ Statistics autorun started (every ${interval} minutes) for date: ${session.date}`);
    } else {
      // One-time stats
      await ctx.reply('Fetching statistics...');
      const calls = await fetchAllCalls(session.workspace, session.token, session.date);
      const stats = calculateCampaignStats(calls);
      const text = formatCampaignStats(stats, session.date);
      await ctx.reply(text, { parse_mode: 'Markdown' });
    }
  } catch (error: any) {
    await ctx.reply(`Error fetching stats: ${error.message}`);
  } finally {
    session.processing = false;
  }
});

bot.command('flow', async (ctx) => {
  const userId = ctx.from!.id;
  const session = getOrCreateSession(userId);
  
  if (session.processing) {
    return ctx.reply('⏳ Please wait, your previous request is still processing...');
  }
  
  session.processing = true;
  
  try {
    await ctx.reply('Checking flow...');
    const calls = await fetchAllCalls(session.workspace, session.token, session.date);
    const stats = calculateCampaignStats(calls);
    const totalFlow = calculateTotalFlow(stats);
    
    let text = `*Flow Check (${session.date})*\n\n`;
    text += `Total Flow: *${totalFlow}* (Live)\n\n`;
    
    if (totalFlow < 60) {
      text += '*⚠️ ALERT: Check flow Kindly*\n\n';
    } else {
      text += '✅ Flow is healthy\n\n';
    }
    
    text += '*Campaign Breakdown:*\n';
    const sortedStats = Array.from(stats.values()).sort((a, b) => a.name.localeCompare(b.name));
    sortedStats.forEach(s => {
      text += `• ${s.name} => ${s.live}\n`;
    });
    
    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (error: any) {
    await ctx.reply(`Error checking flow: ${error.message}`);
  } finally {
    session.processing = false;
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
  const session = getOrCreateSession(userId);
  
  if (session.autorunJobs.size === 0) {
    return ctx.reply('No autoruns currently active.');
  }
  
  const stopped: string[] = [];
  session.autorunJobs.forEach((job, name) => {
    clearInterval(job.interval);
    stopped.push(name);
  });
  
  session.autorunJobs.clear();
  await ctx.reply(`Stopped autoruns: ${stopped.join(', ')}`);
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
      await ctx.reply(
        `Date filter updated to: *${text}*\n\n` +
        `Available commands:\n` +
        `• /stats [start INTERVAL] - Campaign statistics\n` +
        `• /flow - Check total flow\n` +
        `• /changedate - Change date filter\n` +
        `• /stopauto - Stop all autoruns\n` +
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
  res.send('Bot is running');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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