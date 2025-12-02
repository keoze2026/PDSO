"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const telegraf_1 = require("telegraf");
const axios_1 = __importDefault(require("axios"));
const p_limit_1 = __importDefault(require("p-limit"));
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8067862927:AAF15wt-h8YGfXhtdN0kOXu3MQf-zGX0gWU';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://tgbot-nyyq.onrender.com';
const PORT = parseInt(process.env.PORT || '8080');
const BASE_API = 'https://api-gateway.dialics.com/api/v1';
const DIALICS_WORKSPACE = 'aq2O7TXNfZl7H6kjhm2LEw8OI2rJwLwD';
const DIALICS_API_TOKEN = '463907|nVI45fhW3Dq12lUTLUWwRQyeu2Iy1Z078lHSwbIxtD2H4g0LxVjax6gj0b6kEwbVnfJjYpiHSVcXMeCyXF8rgI8OzHA2PzfmntTNZYbsIhGOmCfdlzafKSGmja479fmsf8TK0jxOhM4dKDUOR2vGE44fmInqfFUvdba0WgfgXwWJVn9YjD6TGfLGTIXnTjUTDK0ynOIYXNX65KqgvjfEuvfuiuleW6LedDjR0DeowL4lKFQkZbWfOgqwa8cmqO8u';
const userSessions = new Map();
const bot = new telegraf_1.Telegraf(TELEGRAM_BOT_TOKEN);
const app = (0, express_1.default)();
app.use(express_1.default.json());
const getCurrentDate = () => {
    return new Date().toISOString().split('T')[0];
};
const getOrCreateSession = (userId) => {
    if (!userSessions.has(userId)) {
        userSessions.set(userId, {
            workspace: DIALICS_WORKSPACE,
            token: DIALICS_API_TOKEN,
            date: getCurrentDate(),
            autorunJobs: new Map(),
            processing: false,
        });
    }
    return userSessions.get(userId);
};
const buildUrl = (workspace, endpoint) => {
    return `${BASE_API}/${workspace}/${endpoint.replace(/^\//, '')}`;
};
const apiGet = async (workspace, token, endpoint, params = {}) => {
    const url = buildUrl(workspace, endpoint);
    const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
    };
    try {
        const response = await axios_1.default.get(url, { headers, params, timeout: 30000 });
        return response.data;
    }
    catch (error) {
        console.error(`API Error: ${error.message}`);
        throw new Error(`API request failed: ${error.message}`);
    }
};
const buildParamsWithDate = (date, extra = {}) => {
    return {
        date,
        dateTo: date,
        timezone: '21',
        ...extra,
    };
};
const fetchAllCalls = async (workspace, token, date, useCache = false, session) => {
    if (useCache && session?.cachedCalls && session.cachedCalls.date === date) {
        const cacheAge = Date.now() - session.cachedCalls.timestamp;
        if (cacheAge < 120000) {
            console.log('Using cached calls data');
            return session.cachedCalls.data;
        }
    }
    const allCalls = [];
    const firstParams = buildParamsWithDate(date, { page: 1, perPage: 100 });
    const firstResponse = await apiGet(workspace, token, 'calls/log', firstParams);
    if (!firstResponse.success || !firstResponse.payload?.data) {
        console.warn('Unexpected response format');
        return allCalls;
    }
    allCalls.push(...firstResponse.payload.data);
    const lastPage = firstResponse.payload.last_page || 1;
    console.log(`Fetched page 1/${lastPage}: ${firstResponse.payload.data.length} calls`);
    if (lastPage <= 1) {
        console.log(`Total calls fetched: ${allCalls.length} (single page)`);
        if (session) {
            session.cachedCalls = { data: allCalls, timestamp: Date.now(), date };
        }
        return allCalls;
    }
    const limit = (0, p_limit_1.default)(20);
    const pagePromises = [];
    for (let page = 2; page <= lastPage; page++) {
        pagePromises.push(limit(async () => {
            try {
                const params = buildParamsWithDate(date, { page, perPage: 100 });
                const response = await apiGet(workspace, token, 'calls/log', params);
                if (response.success && response.payload?.data) {
                    console.log(`Fetched page ${page}/${lastPage}: ${response.payload.data.length} calls`);
                    return response.payload.data;
                }
                return [];
            }
            catch (error) {
                console.error(`Error fetching page ${page}:`, error);
                return [];
            }
        }));
    }
    const results = await Promise.all(pagePromises);
    results.forEach(pageData => allCalls.push(...pageData));
    console.log(`Total calls fetched: ${allCalls.length} across ${lastPage} pages`);
    if (session) {
        session.cachedCalls = { data: allCalls, timestamp: Date.now(), date };
    }
    return allCalls;
};
const isCallConnected = (call) => {
    const isLive = call.live === 1;
    const statusName = call.status?.name?.toLowerCase() || '';
    const vendorStatusName = call.vendor_status?.name?.toLowerCase() || '';
    return isLive ||
        statusName.includes('completed') ||
        vendorStatusName.includes('completed - with conversion');
};
const calculateCampaignStats = (calls) => {
    const stats = new Map();
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
        const campaignStats = stats.get(campaignName);
        const isLive = call.live === 1;
        const isQueued = call.queued === 1;
        const duration = call.duration || 0;
        const tfn = call.called_number || 'Unknown';
        if (!campaignStats.tfns.has(tfn)) {
            campaignStats.tfns.set(tfn, { tfn, liveCount: 0, totalDuration: 0, connectedCount: 0, aht: 0 });
        }
        if (isLive) {
            campaignStats.tfns.get(tfn).liveCount++;
            campaignStats.live++;
        }
        if (isQueued) {
            campaignStats.incoming++;
        }
        const isConnected = isCallConnected(call);
        if (isConnected && duration > 0) {
            campaignStats.connected++;
            campaignStats.totalDuration += duration;
            const tfnStats = campaignStats.tfns.get(tfn);
            tfnStats.totalDuration += duration;
            tfnStats.connectedCount++;
        }
    }
    stats.forEach(s => {
        if (s.connected > 0) {
            s.aht = s.totalDuration / s.connected;
        }
        s.tfns.forEach(tfnStats => {
            if (tfnStats.connectedCount > 0) {
                tfnStats.aht = tfnStats.totalDuration / tfnStats.connectedCount;
            }
        });
    });
    return stats;
};
const formatDuration = (seconds) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};
const formatCampaignStats = (stats, date) => {
    if (stats.size === 0)
        return 'No campaigns currently active.';
    let text = `*Campaign Stats (${date})*\n\n`;
    const sortedStats = Array.from(stats.values()).sort((a, b) => a.name.localeCompare(b.name));
    sortedStats.forEach(s => {
        text += `*Campaign* => ${s.name}\n`;
        text += `*TFNs:*\n`;
        const sortedTfns = Array.from(s.tfns.values()).sort((a, b) => a.tfn.localeCompare(b.tfn));
        sortedTfns.forEach(tfn => {
            if (tfn.liveCount > 0) {
                text += `  ${tfn.tfn} - ${tfn.liveCount}\n`;
            }
        });
        text += `*Live* => ${s.live}\n`;
        text += `*Connected* => ${s.connected}\n`;
        text += `*AHT* => ${formatDuration(s.aht)}\n`;
        text += `\n`;
    });
    return text.trim();
};
const formatTFNStats = (stats, date) => {
    if (stats.size === 0)
        return 'No campaigns currently active.';
    let text = `*Campaign TFN Stats (${date})*\n\n`;
    const sortedStats = Array.from(stats.values()).sort((a, b) => a.name.localeCompare(b.name));
    sortedStats.forEach(s => {
        text += `*Campaign* => ${s.name}\n`;
        text += `*TFNs:*\n`;
        const sortedTfns = Array.from(s.tfns.values()).sort((a, b) => a.tfn.localeCompare(b.tfn));
        sortedTfns.forEach(tfn => {
            if (tfn.connectedCount > 0) {
                text += `  ${tfn.tfn} - ${tfn.connectedCount} (AHT ${formatDuration(tfn.aht)})\n`;
            }
        });
        text += `*Live* => ${s.live}\n`;
        text += `*Connected* => ${s.connected}\n`;
        text += `\n`;
    });
    return text.trim();
};
const calculateTotalFlow = (stats) => {
    let total = 0;
    stats.forEach(s => {
        total += s.live;
    });
    return total;
};
const getChatId = (ctx) => {
    return ctx.chat.id;
};
bot.command('start', async (ctx) => {
    const userId = ctx.from.id;
    const session = getOrCreateSession(userId);
    await ctx.reply(`*Welcome to the Campaign Stats Bot!* 🤖\n\n` +
        `*Current Date:* ${session.date}\n\n` +
        `*Statistics:*\n` +
        `/stats [start INTERVAL] — View campaign statistics\n` +
        `/viewtfns — View TFN-specific statistics with AHT\n` +
        `/flow — Check total flow and alert if below 60\n` +
        `/stopauto — Stop all autoruns\n\n` +
        `*Configuration:*\n` +
        `/changedate — Change the date filter\n` +
        `/clear — Clear your session data\n\n` +
        `*Examples:*\n` +
        `\`/stats\` — View current campaign stats\n` +
        `\`/stats start 5\` — Auto-check stats every 5 minutes\n` +
        `\`/viewtfns\` — View TFN statistics with AHT\n` +
        `\`/flow\` — Check if total flow is below 60\n\n` +
        `*Note:* By default, the bot uses today's date. Use /changedate to analyze a different date.`, { parse_mode: 'Markdown' });
});
bot.command('help', async (ctx) => {
    const userId = ctx.from.id;
    const session = getOrCreateSession(userId);
    await ctx.reply(`*Campaign Stats Bot Help* 📊\n\n` +
        `*Current Date:* ${session.date}\n\n` +
        `*Statistics:*\n` +
        `/stats [start INTERVAL] — View campaign statistics\n` +
        `/viewtfns — View TFN-specific statistics with AHT\n` +
        `/flow — Check total flow and alert if below 60\n` +
        `/stopauto — Stop all autoruns\n\n` +
        `*Configuration:*\n` +
        `/changedate — Change the date filter\n` +
        `/clear — Clear your session data\n\n` +
        `*Examples:*\n` +
        `\`/stats\` — View current campaign stats\n` +
        `\`/stats start 5\` — Auto-check stats every 5 minutes\n` +
        `\`/viewtfns\` — View TFN statistics with AHT\n` +
        `\`/flow\` — Check if total flow is below 60\n\n` +
        `*Note:* By default, the bot uses today's date. Use /changedate to analyze a different date.`, { parse_mode: 'Markdown' });
});
bot.command('stats', async (ctx) => {
    const userId = ctx.from.id;
    const chatId = getChatId(ctx);
    const session = getOrCreateSession(userId);
    if (session.processing) {
        return ctx.reply('⏳ Please wait, your previous request is still processing...');
    }
    session.processing = true;
    try {
        const args = ctx.message.text.split(' ').slice(1);
        if (args[0] === 'start') {
            const interval = Math.max(parseInt(args[1]) || 5, 1);
            const existingJob = session.autorunJobs.get('stats');
            if (existingJob) {
                clearInterval(existingJob.interval);
            }
            await ctx.reply('Fetching statistics...');
            const calls = await fetchAllCalls(session.workspace, session.token, session.date, false, session);
            const stats = calculateCampaignStats(calls);
            const text = formatCampaignStats(stats, session.date);
            await ctx.reply(text, { parse_mode: 'Markdown' });
            const job = setInterval(async () => {
                try {
                    const calls = await fetchAllCalls(session.workspace, session.token, session.date, true, session);
                    const stats = calculateCampaignStats(calls);
                    const text = formatCampaignStats(stats, session.date);
                    await ctx.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown' });
                }
                catch (error) {
                    console.error('Autorun stats error:', error);
                }
            }, interval * 60 * 1000);
            session.autorunJobs.set('stats', { interval: job, chatId });
            await ctx.reply(`✅ Statistics autorun started (every ${interval} minutes) for date: ${session.date}`);
        }
        else {
            await ctx.reply('Fetching statistics...');
            const calls = await fetchAllCalls(session.workspace, session.token, session.date, false, session);
            const stats = calculateCampaignStats(calls);
            const text = formatCampaignStats(stats, session.date);
            await ctx.reply(text, { parse_mode: 'Markdown' });
        }
    }
    catch (error) {
        await ctx.reply(`Error fetching stats: ${error.message}`);
    }
    finally {
        session.processing = false;
    }
});
bot.command('viewtfns', async (ctx) => {
    const userId = ctx.from.id;
    const session = getOrCreateSession(userId);
    if (session.processing) {
        return ctx.reply('⏳ Please wait, your previous request is still processing...');
    }
    session.processing = true;
    try {
        await ctx.reply('Fetching TFN statistics...');
        const calls = await fetchAllCalls(session.workspace, session.token, session.date, true, session);
        const stats = calculateCampaignStats(calls);
        const text = formatTFNStats(stats, session.date);
        await ctx.reply(text, { parse_mode: 'Markdown' });
    }
    catch (error) {
        await ctx.reply(`Error fetching TFN stats: ${error.message}`);
    }
    finally {
        session.processing = false;
    }
});
bot.command('flow', async (ctx) => {
    const userId = ctx.from.id;
    const session = getOrCreateSession(userId);
    if (session.processing) {
        return ctx.reply('⏳ Please wait, your previous request is still processing...');
    }
    session.processing = true;
    try {
        await ctx.reply('Checking flow...');
        const calls = await fetchAllCalls(session.workspace, session.token, session.date, true, session);
        const stats = calculateCampaignStats(calls);
        const totalFlow = calculateTotalFlow(stats);
        let text = `*Flow Check (${session.date})*\n\n`;
        text += `Total Flow: *${totalFlow}* (Live)\n\n`;
        if (totalFlow < 60) {
            text += '*⚠️ ALERT: Check flow Kindly*\n\n';
        }
        else {
            text += '✅ Flow is healthy\n\n';
        }
        text += '*Campaign Breakdown:*\n';
        const sortedStats = Array.from(stats.values()).sort((a, b) => a.name.localeCompare(b.name));
        sortedStats.forEach(s => {
            text += `• ${s.name} => ${s.live}\n`;
        });
        await ctx.reply(text, { parse_mode: 'Markdown' });
    }
    catch (error) {
        await ctx.reply(`Error checking flow: ${error.message}`);
    }
    finally {
        session.processing = false;
    }
});
bot.command('changedate', async (ctx) => {
    const userId = ctx.from.id;
    const session = getOrCreateSession(userId);
    await ctx.reply(`Current date filter: *${session.date}*\n\n` +
        `Enter a new date to filter calls (format: YYYY-MM-DD)\n` +
        `Example: 2025-11-26\n` +
        `Or send /cancel to keep current date.`, { parse_mode: 'Markdown' });
});
bot.command('cancel', async (ctx) => {
    const userId = ctx.from.id;
    const session = getOrCreateSession(userId);
    await ctx.reply(`Date change cancelled. Current date: *${session.date}*`, { parse_mode: 'Markdown' });
});
bot.command('stopauto', async (ctx) => {
    const userId = ctx.from.id;
    const session = getOrCreateSession(userId);
    if (session.autorunJobs.size === 0) {
        return ctx.reply('No autoruns currently active.');
    }
    const stopped = [];
    session.autorunJobs.forEach((job, name) => {
        clearInterval(job.interval);
        stopped.push(name);
    });
    session.autorunJobs.clear();
    await ctx.reply(`Stopped autoruns: ${stopped.join(', ')}`);
});
bot.command('clear', async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);
    if (session) {
        session.autorunJobs.forEach(job => clearInterval(job.interval));
        userSessions.delete(userId);
    }
    await ctx.reply('Cleared your session data.\nYour next command will automatically use today\'s date.');
});
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const text = ctx.message.text;
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (dateRegex.test(text)) {
        const session = getOrCreateSession(userId);
        try {
            const date = new Date(text);
            if (isNaN(date.getTime())) {
                return ctx.reply('Invalid date format. Please use YYYY-MM-DD format.\nExample: 2025-11-26');
            }
            session.date = text;
            session.cachedCalls = undefined;
            await ctx.reply(`Date filter updated to: *${text}*\n\n` +
                `Available commands:\n` +
                `• /stats [start INTERVAL] - Campaign statistics\n` +
                `• /viewtfns - View TFN statistics with AHT\n` +
                `• /flow - Check total flow\n` +
                `• /changedate - Change date filter\n` +
                `• /stopauto - Stop all autoruns\n` +
                `• /help - Show help`, { parse_mode: 'Markdown' });
        }
        catch (error) {
            await ctx.reply('Invalid date format. Please use YYYY-MM-DD format.\nExample: 2025-11-26');
        }
    }
});
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
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
const startServer = async () => {
    if (!WEBHOOK_URL) {
        console.error('='.repeat(60));
        console.error('CRITICAL: WEBHOOK_URL environment variable is not set!');
        console.error('Please set WEBHOOK_URL to your deployment URL');
        console.error('Example: https://yourapp.render.com');
        console.error('='.repeat(60));
    }
    else {
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
//# sourceMappingURL=index.js.map