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
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const PORT = parseInt(process.env.PORT || '8080');
const BASE_API = 'https://api-gateway.dialics.com/api/v1';
const CACHE_TTL_MS = 15000;
const CONCURRENT_API_LIMIT = 25;
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
const EXCLUDED_CAMPAIGNS = [
    '11 Camp Ext'
];
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
            date: getCurrentDate(),
            autorunJobs: new Map(),
            processing: new Map(),
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
const fetchAllCallsFromSingleWorkspace = async (workspaceName, workspace, token, date) => {
    try {
        const allCalls = [];
        const seenUuids = new Set();
        const firstParams = buildParamsWithDate(date, { page: 1, perPage: 100 });
        const firstResponse = await apiGet(workspace, token, 'calls/log', firstParams);
        if (!firstResponse.success || !firstResponse.payload?.data) {
            console.warn(`[${workspaceName}] Unexpected response format`);
            return { workspaceName, calls: [], success: false, error: 'Unexpected response format' };
        }
        firstResponse.payload.data.forEach(call => {
            const uuid = call.uuid;
            if (uuid && !seenUuids.has(uuid)) {
                seenUuids.add(uuid);
                allCalls.push(call);
            }
            else if (!uuid) {
                allCalls.push(call);
            }
        });
        const lastPage = firstResponse.payload.last_page || 1;
        console.log(`[${workspaceName}] Fetched page 1/${lastPage}: ${firstResponse.payload.data.length} calls`);
        if (lastPage <= 1) {
            console.log(`[${workspaceName}] Total calls fetched: ${allCalls.length} (single page)`);
            return { workspaceName, calls: allCalls, success: true };
        }
        const limit = (0, p_limit_1.default)(CONCURRENT_API_LIMIT);
        const pagePromises = [];
        for (let page = 2; page <= lastPage; page++) {
            pagePromises.push(limit(async () => {
                try {
                    const params = buildParamsWithDate(date, { page, perPage: 100 });
                    const response = await apiGet(workspace, token, 'calls/log', params);
                    if (response.success && response.payload?.data) {
                        console.log(`[${workspaceName}] Fetched page ${page}/${lastPage}: ${response.payload.data.length} calls`);
                        return response.payload.data;
                    }
                    return [];
                }
                catch (error) {
                    console.error(`[${workspaceName}] Error fetching page ${page}:`, error);
                    return [];
                }
            }));
        }
        const results = await Promise.all(pagePromises);
        results.forEach(pageData => {
            pageData.forEach(call => {
                const uuid = call.uuid;
                if (uuid && !seenUuids.has(uuid)) {
                    seenUuids.add(uuid);
                    allCalls.push(call);
                }
                else if (!uuid) {
                    allCalls.push(call);
                }
            });
        });
        console.log(`[${workspaceName}] Total calls fetched: ${allCalls.length} across ${lastPage} pages (unique: ${seenUuids.size})`);
        return { workspaceName, calls: allCalls, success: true };
    }
    catch (error) {
        console.error(`[${workspaceName}] Error fetching calls:`, error);
        return { workspaceName, calls: [], success: false, error: error.message };
    }
};
const fetchAllCallsFromMultipleWorkspaces = async (workspaceConfigs, date, useCache = false, session) => {
    if (useCache && session?.cachedCalls && session.cachedCalls.date === date) {
        const cacheAge = Date.now() - session.cachedCalls.timestamp;
        if (cacheAge < CACHE_TTL_MS) {
            console.log(`✓ Using cached calls (${session.cachedCalls.data.length} calls, age: ${Math.round(cacheAge / 1000)}s)`);
            return session.cachedCalls.data;
        }
        console.log(`✗ Cache expired (age: ${Math.round(cacheAge / 1000)}s), refreshing...`);
    }
    console.log(`Fetching calls from ${workspaceConfigs.length} workspaces in parallel...`);
    const fetchPromises = workspaceConfigs.map(config => fetchAllCallsFromSingleWorkspace(config.name, config.workspace, config.token, date));
    const results = await Promise.all(fetchPromises);
    results.forEach(result => {
        if (result.success) {
            console.log(`[${result.workspaceName}] Successfully fetched ${result.calls.length} calls`);
        }
        else {
            console.error(`[${result.workspaceName}] Failed: ${result.error}`);
        }
    });
    const allCalls = results
        .filter(r => r.success)
        .flatMap(r => r.calls);
    console.log(`Total calls from all workspaces: ${allCalls.length}`);
    if (session) {
        session.cachedCalls = {
            data: allCalls,
            timestamp: Date.now(),
            date: date
        };
        console.log(`✓ Cached ${allCalls.length} calls for date: ${date}`);
    }
    return allCalls;
};
const calculateCampaignStats = (calls) => {
    const statsMap = new Map();
    calls.forEach(call => {
        const campaignName = call.campaign?.name;
        if (!campaignName || EXCLUDED_CAMPAIGNS.includes(campaignName)) {
            return;
        }
        if (!statsMap.has(campaignName)) {
            statsMap.set(campaignName, {
                name: campaignName,
                live: 0,
                incoming: 0,
                connected: 0,
                totalDuration: 0,
                aht: 0,
                tfns: new Map()
            });
        }
        const stats = statsMap.get(campaignName);
        if (call.live === 1) {
            stats.live++;
        }
        if (call.queued === 1) {
            stats.incoming++;
        }
        const statusName = call.status?.name?.toLowerCase() || '';
        const vendorStatusName = call.vendor_status?.name?.toLowerCase() || '';
        if (statusName === 'connected' || vendorStatusName === 'answered') {
            stats.connected++;
            stats.totalDuration += call.duration || 0;
        }
    });
    statsMap.forEach(stats => {
        if (stats.connected > 0) {
            stats.aht = Math.round(stats.totalDuration / stats.connected);
        }
    });
    return statsMap;
};
const calculateTFNStats = (calls) => {
    const tfnMap = new Map();
    calls.forEach(call => {
        const campaignName = call.campaign?.name;
        if (campaignName && EXCLUDED_CAMPAIGNS.includes(campaignName)) {
            return;
        }
        const tfn = call.called_number;
        if (!tfn)
            return;
        if (!tfnMap.has(tfn)) {
            tfnMap.set(tfn, {
                tfn,
                liveCount: 0,
                totalDuration: 0,
                connectedCount: 0,
                aht: 0
            });
        }
        const stats = tfnMap.get(tfn);
        if (call.live === 1) {
            stats.liveCount++;
        }
        const statusName = call.status?.name?.toLowerCase() || '';
        const vendorStatusName = call.vendor_status?.name?.toLowerCase() || '';
        if (statusName === 'connected' || vendorStatusName === 'answered') {
            stats.connectedCount++;
            stats.totalDuration += call.duration || 0;
        }
    });
    const tfnStats = Array.from(tfnMap.values());
    tfnStats.forEach(stats => {
        if (stats.connectedCount > 0) {
            stats.aht = Math.round(stats.totalDuration / stats.connectedCount);
        }
    });
    return tfnStats.sort((a, b) => b.liveCount - a.liveCount);
};
const getRepeatCallers = (calls) => {
    const callerMap = new Map();
    calls.forEach(call => {
        const campaignName = call.campaign?.name;
        if (campaignName && EXCLUDED_CAMPAIGNS.includes(campaignName)) {
            return;
        }
        const callerNumber = call.caller_number;
        if (!callerNumber)
            return;
        if (!callerMap.has(callerNumber)) {
            callerMap.set(callerNumber, {
                count: 0,
                campaigns: new Set()
            });
        }
        const data = callerMap.get(callerNumber);
        data.count++;
        if (campaignName) {
            data.campaigns.add(campaignName);
        }
    });
    return Array.from(callerMap.entries())
        .filter(([_, data]) => data.count >= 2)
        .map(([number, data]) => ({
        number,
        count: data.count,
        campaigns: data.campaigns
    }))
        .sort((a, b) => b.count - a.count);
};
const calculateTotalFlow = (stats) => {
    let totalLive = 0;
    stats.forEach(s => {
        totalLive += s.live;
    });
    return totalLive;
};
const getChatId = (ctx) => {
    return ctx.chat.id;
};
const isChatProcessing = (session, chatId) => {
    return session.processing.get(chatId) || false;
};
const setChatProcessing = (session, chatId, processing) => {
    session.processing.set(chatId, processing);
};
bot.command('start', async (ctx) => {
    const userId = ctx.from.id;
    const session = getOrCreateSession(userId);
    const parts = [];
    parts.push(`Welcome to the Multi-Workspace Call Monitoring Bot!\n\n`);
    parts.push(`Current date filter: *${session.date}*\n\n`);
    parts.push(`*Available Commands:*\n`);
    parts.push(`• /stats [start INTERVAL] - Campaign statistics\n`);
    parts.push(`• /viewtfns [start INTERVAL] - View TFN statistics with AHT\n`);
    parts.push(`• /getivr [start INTERVAL] - View repeat callers\n`);
    parts.push(`• /flow [start INTERVAL] - Check total flow\n`);
    parts.push(`• /changedate - Change date filter\n`);
    parts.push(`• /stopauto - Stop autoruns in this channel\n`);
    parts.push(`• /clear - Clear session data\n`);
    parts.push(`• /help - Show this help message\n\n`);
    parts.push(`*Autorun Examples:*\n`);
    parts.push(`• /stats start 5 - Stats every 5 minutes\n`);
    parts.push(`• /flow start 10 - Flow check every 10 minutes\n\n`);
    parts.push(`*Features:*\n`);
    parts.push(`• Smart caching (${CACHE_TTL_MS / 1000}s TTL)\n`);
    parts.push(`• Channel-isolated autoruns\n`);
    parts.push(`• Multi-workspace support\n`);
    parts.push(`• Optimized performance (${CONCURRENT_API_LIMIT} concurrent requests)`);
    await ctx.reply(parts.join(''), { parse_mode: 'Markdown' });
});
bot.command('help', async (ctx) => {
    const userId = ctx.from.id;
    const session = getOrCreateSession(userId);
    const parts = [];
    parts.push(`*Multi-Workspace Call Monitoring Bot*\n\n`);
    parts.push(`Current date: *${session.date}*\n\n`);
    parts.push(`*Commands:*\n`);
    parts.push(`• /stats - Campaign statistics\n`);
    parts.push(`• /viewtfns - TFN statistics with AHT\n`);
    parts.push(`• /getivr - Repeat callers\n`);
    parts.push(`• /flow - Total flow check\n`);
    parts.push(`• /changedate - Change date filter\n`);
    parts.push(`• /stopauto - Stop autoruns\n`);
    parts.push(`• /clear - Clear session\n\n`);
    parts.push(`*Autorun Syntax:*\n`);
    parts.push(`Add "start INTERVAL" to any command:\n`);
    parts.push(`Example: /stats start 5\n\n`);
    parts.push(`*Performance:*\n`);
    parts.push(`• Cache TTL: ${CACHE_TTL_MS / 1000} seconds\n`);
    parts.push(`• Concurrent requests: ${CONCURRENT_API_LIMIT}\n`);
    parts.push(`• Workspaces: ${WORKSPACES.length}`);
    await ctx.reply(parts.join(''), { parse_mode: 'Markdown' });
});
bot.command('stats', async (ctx) => {
    const userId = ctx.from.id;
    const chatId = getChatId(ctx);
    const session = getOrCreateSession(userId);
    if (isChatProcessing(session, chatId)) {
        return ctx.reply('⏳ A request is already being processed in this channel. Please wait...');
    }
    setChatProcessing(session, chatId, true);
    try {
        const text = ctx.message.text.trim();
        const parts = text.split(/\s+/);
        if (parts.length === 3 && parts[1].toLowerCase() === 'start') {
            const interval = parseInt(parts[2]);
            if (isNaN(interval) || interval < 1) {
                setChatProcessing(session, chatId, false);
                return ctx.reply('Invalid interval. Usage: /stats start INTERVAL (e.g., /stats start 5)');
            }
            const jobKey = `stats-${chatId}`;
            if (session.autorunJobs.has(jobKey)) {
                setChatProcessing(session, chatId, false);
                return ctx.reply(`Stats autorun already running in this channel. Use /stopauto to stop it first.`);
            }
            await ctx.reply('Fetching initial campaign statistics...');
            const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, true, session);
            const stats = calculateCampaignStats(calls);
            const textParts = [];
            textParts.push(`*Campaign Statistics (${session.date})*\n\n`);
            const sortedStats = Array.from(stats.values()).sort((a, b) => a.name.localeCompare(b.name));
            sortedStats.forEach(s => {
                textParts.push(`*${s.name}*\n`);
                textParts.push(`├ Live: ${s.live}\n`);
                textParts.push(`├ Incoming: ${s.incoming}\n`);
                textParts.push(`├ Connected: ${s.connected}\n`);
                textParts.push(`└ AHT: ${s.aht}s\n\n`);
            });
            await ctx.reply(textParts.join(''), { parse_mode: 'Markdown' });
            const job = setInterval(async () => {
                try {
                    const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, true, session);
                    const stats = calculateCampaignStats(calls);
                    const textParts = [];
                    textParts.push(`*Campaign Statistics (${session.date})*\n\n`);
                    const sortedStats = Array.from(stats.values()).sort((a, b) => a.name.localeCompare(b.name));
                    sortedStats.forEach(s => {
                        textParts.push(`*${s.name}*\n`);
                        textParts.push(`├ Live: ${s.live}\n`);
                        textParts.push(`├ Incoming: ${s.incoming}\n`);
                        textParts.push(`├ Connected: ${s.connected}\n`);
                        textParts.push(`└ AHT: ${s.aht}s\n\n`);
                    });
                    await ctx.telegram.sendMessage(chatId, textParts.join(''), { parse_mode: 'Markdown' });
                }
                catch (error) {
                    console.error('Autorun stats error:', error);
                }
            }, interval * 60 * 1000);
            session.autorunJobs.set(jobKey, { interval: job, chatId, commandName: 'stats' });
            await ctx.reply(`Stats autorun started (every ${interval} minutes, cache: ${CACHE_TTL_MS / 1000}s) for date: ${session.date}\nThis autorun is specific to this channel.`);
        }
        else {
            await ctx.reply('Fetching campaign statistics from all workspaces...');
            const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, true, session);
            const stats = calculateCampaignStats(calls);
            const textParts = [];
            textParts.push(`*Campaign Statistics (${session.date})*\n\n`);
            const sortedStats = Array.from(stats.values()).sort((a, b) => a.name.localeCompare(b.name));
            sortedStats.forEach(s => {
                textParts.push(`*${s.name}*\n`);
                textParts.push(`├ Live: ${s.live}\n`);
                textParts.push(`├ Incoming: ${s.incoming}\n`);
                textParts.push(`├ Connected: ${s.connected}\n`);
                textParts.push(`└ AHT: ${s.aht}s\n\n`);
            });
            await ctx.reply(textParts.join(''), { parse_mode: 'Markdown' });
        }
    }
    catch (error) {
        await ctx.reply(`Error fetching stats: ${error.message}`);
    }
    finally {
        setChatProcessing(session, chatId, false);
    }
});
bot.command('viewtfns', async (ctx) => {
    const userId = ctx.from.id;
    const chatId = getChatId(ctx);
    const session = getOrCreateSession(userId);
    if (isChatProcessing(session, chatId)) {
        return ctx.reply('⏳ A request is already being processed in this channel. Please wait...');
    }
    setChatProcessing(session, chatId, true);
    try {
        const text = ctx.message.text.trim();
        const parts = text.split(/\s+/);
        if (parts.length === 3 && parts[1].toLowerCase() === 'start') {
            const interval = parseInt(parts[2]);
            if (isNaN(interval) || interval < 1) {
                setChatProcessing(session, chatId, false);
                return ctx.reply('Invalid interval. Usage: /viewtfns start INTERVAL (e.g., /viewtfns start 5)');
            }
            const jobKey = `viewtfns-${chatId}`;
            if (session.autorunJobs.has(jobKey)) {
                setChatProcessing(session, chatId, false);
                return ctx.reply(`TFN stats autorun already running in this channel. Use /stopauto to stop it first.`);
            }
            await ctx.reply('Fetching initial TFN statistics...');
            const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, true, session);
            const tfnStats = calculateTFNStats(calls);
            const textParts = [];
            textParts.push(`*TFN Statistics (${session.date})*\n\n`);
            textParts.push(`Total TFNs: ${tfnStats.length}\n\n`);
            tfnStats.forEach((stats, index) => {
                textParts.push(`${index + 1}. *${stats.tfn}*\n`);
                textParts.push(`├ Live: ${stats.liveCount}\n`);
                textParts.push(`├ Connected: ${stats.connectedCount}\n`);
                textParts.push(`└ AHT: ${stats.aht}s\n\n`);
            });
            await ctx.reply(textParts.join(''), { parse_mode: 'Markdown' });
            const job = setInterval(async () => {
                try {
                    const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, true, session);
                    const tfnStats = calculateTFNStats(calls);
                    const textParts = [];
                    textParts.push(`*TFN Statistics (${session.date})*\n\n`);
                    textParts.push(`Total TFNs: ${tfnStats.length}\n\n`);
                    tfnStats.forEach((stats, index) => {
                        textParts.push(`${index + 1}. *${stats.tfn}*\n`);
                        textParts.push(`├ Live: ${stats.liveCount}\n`);
                        textParts.push(`├ Connected: ${stats.connectedCount}\n`);
                        textParts.push(`└ AHT: ${stats.aht}s\n\n`);
                    });
                    await ctx.telegram.sendMessage(chatId, textParts.join(''), { parse_mode: 'Markdown' });
                }
                catch (error) {
                    console.error('Autorun viewtfns error:', error);
                }
            }, interval * 60 * 1000);
            session.autorunJobs.set(jobKey, { interval: job, chatId, commandName: 'viewtfns' });
            await ctx.reply(`TFN stats autorun started (every ${interval} minutes, cache: ${CACHE_TTL_MS / 1000}s) for date: ${session.date}\nThis autorun is specific to this channel.`);
        }
        else {
            await ctx.reply('Fetching TFN statistics from all workspaces...');
            const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, true, session);
            const tfnStats = calculateTFNStats(calls);
            const textParts = [];
            textParts.push(`*TFN Statistics (${session.date})*\n\n`);
            textParts.push(`Total TFNs: ${tfnStats.length}\n\n`);
            tfnStats.forEach((stats, index) => {
                textParts.push(`${index + 1}. *${stats.tfn}*\n`);
                textParts.push(`├ Live: ${stats.liveCount}\n`);
                textParts.push(`├ Connected: ${stats.connectedCount}\n`);
                textParts.push(`└ AHT: ${stats.aht}s\n\n`);
            });
            await ctx.reply(textParts.join(''), { parse_mode: 'Markdown' });
        }
    }
    catch (error) {
        await ctx.reply(`Error fetching TFN stats: ${error.message}`);
    }
    finally {
        setChatProcessing(session, chatId, false);
    }
});
bot.command('getivr', async (ctx) => {
    const userId = ctx.from.id;
    const chatId = getChatId(ctx);
    const session = getOrCreateSession(userId);
    if (isChatProcessing(session, chatId)) {
        return ctx.reply('⏳ A request is already being processed in this channel. Please wait...');
    }
    setChatProcessing(session, chatId, true);
    try {
        const text = ctx.message.text.trim();
        const parts = text.split(/\s+/);
        if (parts.length === 3 && parts[1].toLowerCase() === 'start') {
            const interval = parseInt(parts[2]);
            if (isNaN(interval) || interval < 1) {
                setChatProcessing(session, chatId, false);
                return ctx.reply('Invalid interval. Usage: /getivr start INTERVAL (e.g., /getivr start 5)');
            }
            const jobKey = `getivr-${chatId}`;
            if (session.autorunJobs.has(jobKey)) {
                setChatProcessing(session, chatId, false);
                return ctx.reply(`IVR autorun already running in this channel. Use /stopauto to stop it first.`);
            }
            await ctx.reply('Fetching initial repeat caller data...');
            const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, true, session);
            const repeatCallers = getRepeatCallers(calls);
            const textParts = [];
            textParts.push(`*Repeat Callers (${session.date})*\n\n`);
            textParts.push(`Total repeat callers: ${repeatCallers.length}\n\n`);
            repeatCallers.slice(0, 50).forEach((caller, index) => {
                textParts.push(`${index + 1}. ${caller.number}\n`);
                textParts.push(`├ Calls: ${caller.count}\n`);
                textParts.push(`└ Campaigns: ${Array.from(caller.campaigns).join(', ')}\n\n`);
            });
            if (repeatCallers.length > 50) {
                textParts.push(`\n_Showing top 50 of ${repeatCallers.length} repeat callers_`);
            }
            await ctx.reply(textParts.join(''), { parse_mode: 'Markdown' });
            const job = setInterval(async () => {
                try {
                    const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, true, session);
                    const repeatCallers = getRepeatCallers(calls);
                    const textParts = [];
                    textParts.push(`*Repeat Callers (${session.date})*\n\n`);
                    textParts.push(`Total repeat callers: ${repeatCallers.length}\n\n`);
                    repeatCallers.slice(0, 50).forEach((caller, index) => {
                        textParts.push(`${index + 1}. ${caller.number}\n`);
                        textParts.push(`├ Calls: ${caller.count}\n`);
                        textParts.push(`└ Campaigns: ${Array.from(caller.campaigns).join(', ')}\n\n`);
                    });
                    if (repeatCallers.length > 50) {
                        textParts.push(`\n_Showing top 50 of ${repeatCallers.length} repeat callers_`);
                    }
                    await ctx.telegram.sendMessage(chatId, textParts.join(''), { parse_mode: 'Markdown' });
                }
                catch (error) {
                    console.error('Autorun getivr error:', error);
                }
            }, interval * 60 * 1000);
            session.autorunJobs.set(jobKey, { interval: job, chatId, commandName: 'getivr' });
            await ctx.reply(`Repeat caller autorun started (every ${interval} minutes, cache: ${CACHE_TTL_MS / 1000}s) for date: ${session.date}\nThis autorun is specific to this channel.`);
        }
        else {
            await ctx.reply('Fetching repeat caller data from all workspaces...');
            const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, true, session);
            const repeatCallers = getRepeatCallers(calls);
            const textParts = [];
            textParts.push(`*Repeat Callers (${session.date})*\n\n`);
            textParts.push(`Total repeat callers: ${repeatCallers.length}\n\n`);
            repeatCallers.slice(0, 50).forEach((caller, index) => {
                textParts.push(`${index + 1}. ${caller.number}\n`);
                textParts.push(`├ Calls: ${caller.count}\n`);
                textParts.push(`└ Campaigns: ${Array.from(caller.campaigns).join(', ')}\n\n`);
            });
            if (repeatCallers.length > 50) {
                textParts.push(`\n_Showing top 50 of ${repeatCallers.length} repeat callers_`);
            }
            await ctx.reply(textParts.join(''), { parse_mode: 'Markdown' });
        }
    }
    catch (error) {
        await ctx.reply(`Error fetching repeat callers: ${error.message}`);
    }
    finally {
        setChatProcessing(session, chatId, false);
    }
});
bot.command('flow', async (ctx) => {
    const userId = ctx.from.id;
    const chatId = getChatId(ctx);
    const session = getOrCreateSession(userId);
    if (isChatProcessing(session, chatId)) {
        return ctx.reply('⏳ A request is already being processed in this channel. Please wait...');
    }
    setChatProcessing(session, chatId, true);
    try {
        const text = ctx.message.text.trim();
        const parts = text.split(/\s+/);
        if (parts.length === 3 && parts[1].toLowerCase() === 'start') {
            const interval = parseInt(parts[2]);
            if (isNaN(interval) || interval < 1) {
                setChatProcessing(session, chatId, false);
                return ctx.reply('Invalid interval. Usage: /flow start INTERVAL (e.g., /flow start 5)');
            }
            const jobKey = `flow-${chatId}`;
            if (session.autorunJobs.has(jobKey)) {
                setChatProcessing(session, chatId, false);
                return ctx.reply(`Flow check autorun already running in this channel. Use /stopauto to stop it first.`);
            }
            await ctx.reply('Fetching initial flow data...');
            const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, true, session);
            const stats = calculateCampaignStats(calls);
            const totalFlow = calculateTotalFlow(stats);
            const textParts = [];
            textParts.push(`*Flow Check (${session.date})*\n\n`);
            textParts.push(`Total Flow: *${totalFlow}* (Live)\n\n`);
            if (totalFlow < 60) {
                textParts.push('*⚠️ ALERT: Check flow Kindly*\n\n');
            }
            else {
                textParts.push('Flow is healthy\n\n');
            }
            textParts.push('*Campaign Breakdown:*\n');
            const sortedStats = Array.from(stats.values()).sort((a, b) => a.name.localeCompare(b.name));
            sortedStats.forEach(s => {
                textParts.push(`• ${s.name} => ${s.live}\n`);
            });
            await ctx.reply(textParts.join(''), { parse_mode: 'Markdown' });
            const job = setInterval(async () => {
                try {
                    const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, true, session);
                    const stats = calculateCampaignStats(calls);
                    const totalFlow = calculateTotalFlow(stats);
                    const textParts = [];
                    textParts.push(`*Flow Check (${session.date})*\n\n`);
                    textParts.push(`Total Flow: *${totalFlow}* (Live)\n\n`);
                    if (totalFlow < 60) {
                        textParts.push('*⚠️ ALERT: Check flow Kindly*\n\n');
                    }
                    else {
                        textParts.push('Flow is healthy\n\n');
                    }
                    textParts.push('*Campaign Breakdown:*\n');
                    const sortedStats = Array.from(stats.values()).sort((a, b) => a.name.localeCompare(b.name));
                    sortedStats.forEach(s => {
                        textParts.push(`• ${s.name} => ${s.live}\n`);
                    });
                    await ctx.telegram.sendMessage(chatId, textParts.join(''), { parse_mode: 'Markdown' });
                }
                catch (error) {
                    console.error('Autorun flow error:', error);
                }
            }, interval * 60 * 1000);
            session.autorunJobs.set(jobKey, { interval: job, chatId, commandName: 'flow' });
            await ctx.reply(`Flow check autorun started (every ${interval} minutes, cache: ${CACHE_TTL_MS / 1000}s) for date: ${session.date}\nThis autorun is specific to this channel.`);
        }
        else {
            await ctx.reply('Checking flow from all workspaces...');
            const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, true, session);
            const stats = calculateCampaignStats(calls);
            const totalFlow = calculateTotalFlow(stats);
            const textParts = [];
            textParts.push(`*Flow Check (${session.date})*\n\n`);
            textParts.push(`Total Flow: *${totalFlow}* (Live)\n\n`);
            if (totalFlow < 60) {
                textParts.push('*⚠️ ALERT: Check flow Kindly*\n\n');
            }
            else {
                textParts.push('Flow is healthy\n\n');
            }
            textParts.push('*Campaign Breakdown:*\n');
            const sortedStats = Array.from(stats.values()).sort((a, b) => a.name.localeCompare(b.name));
            sortedStats.forEach(s => {
                textParts.push(`• ${s.name} => ${s.live}\n`);
            });
            await ctx.reply(textParts.join(''), { parse_mode: 'Markdown' });
        }
    }
    catch (error) {
        await ctx.reply(`Error checking flow: ${error.message}`);
    }
    finally {
        setChatProcessing(session, chatId, false);
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
    const chatId = getChatId(ctx);
    const session = getOrCreateSession(userId);
    const jobsForThisChannel = [];
    const stoppedCommands = [];
    session.autorunJobs.forEach((job, jobKey) => {
        if (job.chatId === chatId) {
            clearInterval(job.interval);
            jobsForThisChannel.push(jobKey);
            stoppedCommands.push(job.commandName);
        }
    });
    jobsForThisChannel.forEach(jobKey => {
        session.autorunJobs.delete(jobKey);
    });
    if (stoppedCommands.length === 0) {
        return ctx.reply('No autoruns currently active in this channel.');
    }
    await ctx.reply(`Stopped autoruns in this channel: ${stoppedCommands.join(', ')}\n\nAutoruns in other channels remain active.`);
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
            const parts = [];
            parts.push(`Date filter updated to: *${text}*\n\n`);
            parts.push(`Available commands:\n`);
            parts.push(`• /stats [start INTERVAL] - Campaign statistics\n`);
            parts.push(`• /viewtfns [start INTERVAL] - View TFN statistics with AHT\n`);
            parts.push(`• /getivr [start INTERVAL] - View repeat callers\n`);
            parts.push(`• /flow [start INTERVAL] - Check total flow\n`);
            parts.push(`• /changedate - Change date filter\n`);
            parts.push(`• /stopauto - Stop autoruns in this channel\n`);
            parts.push(`• /help - Show help`);
            await ctx.reply(parts.join(''), { parse_mode: 'Markdown' });
        }
        catch (error) {
            await ctx.reply('Invalid date format. Please use YYYY-MM-DD format.\nExample: 2025-11-26');
        }
    }
});
app.get('/', (req, res) => {
    res.send('Bot is running with multi-workspace support and smart caching');
});
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        workspaces: WORKSPACES.length,
        cacheTTL: `${CACHE_TTL_MS / 1000}s`,
        concurrency: CONCURRENT_API_LIMIT
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
    console.log('='.repeat(60));
    console.log(`Configured workspaces: ${WORKSPACES.length}`);
    WORKSPACES.forEach((ws, index) => {
        console.log(`  ${index + 1}. ${ws.name}: ${ws.workspace}`);
    });
    console.log('Performance Settings:');
    console.log(`  • Cache TTL: ${CACHE_TTL_MS / 1000} seconds`);
    console.log(`  • Concurrent requests: ${CONCURRENT_API_LIMIT}`);
    console.log('Features:');
    console.log('  • Smart caching with TTL');
    console.log('  • Channel-isolated autoruns');
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
//# sourceMappingURL=index.js.map