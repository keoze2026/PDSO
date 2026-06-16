"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const telegraf_1 = require("telegraf");
const axios_1 = __importDefault(require("axios"));
const p_limit_1 = __importDefault(require("p-limit"));
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = parseInt(process.env.PORT || '8080');
const BASE_API = process.env.BASE_API || 'https://public-api.revocalls.com/api/v1';
if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is required in .env file');
}
const WORKSPACES = [
    {
        name: process.env.WORKSPACE_1_NAME || 'Workspace 1',
        workspace: process.env.WORKSPACE_1_ID || '',
        token: process.env.WORKSPACE_1_TOKEN || ''
    },
    {
        name: process.env.WORKSPACE_2_NAME || 'Workspace 2',
        workspace: process.env.WORKSPACE_2_ID || '',
        token: process.env.WORKSPACE_2_TOKEN || ''
    },
    {
        name: process.env.WORKSPACE_3_NAME || 'Workspace 3',
        workspace: process.env.WORKSPACE_3_ID || '',
        token: process.env.WORKSPACE_3_TOKEN || ''
    }
].filter(ws => ws.workspace && ws.token);
const EXCLUDED_CAMPAIGNS = [
    '11 Camp Ext', 'Camp-BBB 2', 'Camp-BBB', 'Camp - AdsTerra', 'Camp - BB2', 'Camp - BB1', 'Adsterra 2', '062026', 'Adsterra'
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
        const limit = (0, p_limit_1.default)(35);
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
        if (cacheAge < 120000) {
            console.log('Using cached calls data');
            return session.cachedCalls.data;
        }
    }
    console.log(`Fetching calls from ${workspaceConfigs.length} workspaces in parallel...`);
    const fetchPromises = workspaceConfigs.map(config => fetchAllCallsFromSingleWorkspace(config.name, config.workspace, config.token, date));
    const results = await Promise.all(fetchPromises);
    const successfulWorkspaces = [];
    const failedWorkspaces = [];
    results.forEach(result => {
        if (result.success) {
            successfulWorkspaces.push(`${result.workspaceName} (${result.calls.length} calls)`);
        }
        else {
            failedWorkspaces.push(`${result.workspaceName} (${result.error || 'unknown error'})`);
        }
    });
    if (successfulWorkspaces.length > 0) {
        console.log(`✓ Successful fetches: ${successfulWorkspaces.join(', ')}`);
    }
    if (failedWorkspaces.length > 0) {
        console.warn(`✗ Failed fetches: ${failedWorkspaces.join(', ')}`);
    }
    const allCalls = [];
    const globalSeenUuids = new Set();
    results.forEach(result => {
        if (result.success) {
            result.calls.forEach(call => {
                const uuid = call.uuid;
                if (uuid && !globalSeenUuids.has(uuid)) {
                    globalSeenUuids.add(uuid);
                    allCalls.push(call);
                }
                else if (!uuid) {
                    allCalls.push(call);
                }
            });
        }
    });
    console.log(`Total merged calls: ${allCalls.length} (unique across all workspaces)`);
    if (session) {
        session.cachedCalls = { data: allCalls, timestamp: Date.now(), date };
    }
    return allCalls;
};
const isCallConnected = (call) => {
    const duration = call.duration || 0;
    const statusName = call.status?.name?.toLowerCase() || '';
    const vendorStatusName = call.vendor_status?.name?.toLowerCase() || '';
    const hasCompletedStatus = statusName.includes('completed') || vendorStatusName.includes('completed');
    const hasDurationAndNotFailed = duration > 0 && !statusName.includes('not connected');
    return hasCompletedStatus || hasDurationAndNotFailed;
};
const calculateCampaignStats = (calls) => {
    const stats = new Map();
    for (const call of calls) {
        const campaignName = call.campaign?.name || 'Unknown Campaign';
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
        const campaignStats = stats.get(campaignName);
        const isLive = call.live == 1;
        const isQueued = call.queued == 1;
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
        if (isConnected) {
            campaignStats.connected++;
            if (duration > 0) {
                campaignStats.totalDuration += duration;
            }
            const tfnStats = campaignStats.tfns.get(tfn);
            tfnStats.connectedCount++;
            if (duration > 0) {
                tfnStats.totalDuration += duration;
            }
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
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};
const extractCampaignNumber = (campaignName) => {
    const campPattern = /^Camp(?:aign)?\s+(\d+)$/i;
    const match = campaignName.match(campPattern);
    if (match) {
        return match[1];
    }
    return campaignName;
};
const formatCampaignStats = (stats, date) => {
    if (stats.size === 0)
        return 'No campaigns currently active.';
    let text = `Campaign Stats (${date})\n\n`;
    const sortedStats = Array.from(stats.values()).sort((a, b) => a.name.localeCompare(b.name));
    sortedStats.forEach((s, index) => {
        const campaignDisplay = extractCampaignNumber(s.name);
        text += `Campaign: ${campaignDisplay}\n`;
        text += `∙ Live: ${s.live}\n`;
        text += `∙ Connected: ${s.connected}\n`;
        text += `∙ Connected AHT: ${formatDuration(s.aht)}\n`;
        if (index < sortedStats.length - 1) {
            text += `--------------------------------                           \n`;
        }
    });
    return text.trim();
};
const formatTFNStats = (stats, date) => {
    if (stats.size === 0)
        return 'No campaigns currently active.';
    let text = `Campaign TFN Stats (${date})\n\n`;
    const sortedStats = Array.from(stats.values()).sort((a, b) => a.name.localeCompare(b.name));
    sortedStats.forEach((s, index) => {
        const campaignDisplay = extractCampaignNumber(s.name);
        text += `Campaign: ${campaignDisplay}\n\n`;
        const sortedTfns = Array.from(s.tfns.values())
            .filter(tfn => tfn.connectedCount > 0)
            .sort((a, b) => b.connectedCount - a.connectedCount);
        if (sortedTfns.length > 0) {
            text += `∙ TFNs:\n`;
            const maxTfnLength = Math.max(...sortedTfns.map(tfn => tfn.tfn.length));
            const maxCountLength = Math.max(...sortedTfns.map(tfn => tfn.connectedCount.toString().length));
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
        if (index < sortedStats.length - 1) {
            text += `--------------------------------                           \n`;
        }
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
const getRepeatCallers = (calls) => {
    const callerCounts = new Map();
    for (const call of calls) {
        const campaignName = call.campaign?.name || 'Unknown Campaign';
        const callerNumber = call.caller_number || 'Unknown';
        if (EXCLUDED_CAMPAIGNS.includes(campaignName)) {
            continue;
        }
        if (!isCallConnected(call)) {
            continue;
        }
        if (!callerCounts.has(campaignName)) {
            callerCounts.set(campaignName, new Map());
        }
        const campaignCallers = callerCounts.get(campaignName);
        campaignCallers.set(callerNumber, (campaignCallers.get(callerNumber) || 0) + 1);
    }
    return callerCounts;
};
const formatRepeatCallers = (callerCounts, date) => {
    let text = `IVR Repeat Callers (${date})\n\n`;
    const sortedCampaigns = Array.from(callerCounts.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    let foundAny = false;
    sortedCampaigns.forEach(([campaignName, callers], campaignIndex) => {
        const repeatCallers = Array.from(callers.entries())
            .filter(([_, count]) => count > 3)
            .sort((a, b) => b[1] - a[1]);
        if (repeatCallers.length > 0) {
            foundAny = true;
            const campaignDisplay = extractCampaignNumber(campaignName);
            text += `Campaign: ${campaignDisplay}\n\n`;
            repeatCallers.forEach(([callerNumber, count]) => {
                text += `∙ ${callerNumber}: ${count} calls\n`;
            });
            const remainingCampaigns = sortedCampaigns.slice(campaignIndex + 1);
            const hasMoreWithData = remainingCampaigns.some(([_, callers]) => Array.from(callers.values()).some(count => count > 3));
            if (hasMoreWithData) {
                text += `--------------------------------                           \n`;
            }
        }
    });
    if (!foundAny) {
        return `IVR Repeat Callers (${date})\n\nNo callers with more than 3 calls found.`;
    }
    return text.trim();
};
const getChatId = (ctx) => {
    return ctx.chat.id;
};
const createJobKey = (commandName, chatId) => {
    return `${commandName}-${chatId}`;
};
const isChatProcessing = (session, chatId) => {
    return session.processing.get(chatId) || false;
};
const setChatProcessing = (session, chatId, state) => {
    session.processing.set(chatId, state);
};
bot.command('start', async (ctx) => {
    const userId = ctx.from.id;
    const session = getOrCreateSession(userId);
    await ctx.reply(`*Welcome to the Campaign Stats Bot!*\n\n` +
        `*Current Date:* ${session.date}\n` +
        `*Workspaces:* ${WORKSPACES.length} workspaces configured\n\n` +
        `*Statistics:*\n` +
        `/stats [start INTERVAL] — View campaign statistics\n` +
        `/viewtfns [start INTERVAL] — View TFN-specific statistics with AHT\n` +
        `/getivr [start INTERVAL] — View repeat callers (>3 calls)\n` +
        `/flow [start INTERVAL] — Check total flow and alert if below 60\n` +
        `/listcampaigns — List all campaigns from workspaces\n` +
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
        `*Note:* The bot fetches data from multiple workspaces simultaneously for faster results. Each channel has independent autoruns. By default, it uses today's date. Use /changedate to analyze a different date.`, { parse_mode: 'Markdown' });
});
bot.command('help', async (ctx) => {
    const userId = ctx.from.id;
    const session = getOrCreateSession(userId);
    await ctx.reply(`*Campaign Stats Bot Help*\n\n` +
        `*Current Date:* ${session.date}\n` +
        `*Workspaces:* ${WORKSPACES.length} workspaces configured\n\n` +
        `*Statistics:*\n` +
        `/stats [start INTERVAL] — View campaign statistics\n` +
        `/viewtfns [start INTERVAL] — View TFN-specific statistics with AHT\n` +
        `/getivr [start INTERVAL] — View repeat callers (>3 calls)\n` +
        `/flow [start INTERVAL] — Check total flow and alert if below 60\n` +
        `/listcampaigns — List all campaigns from workspaces\n` +
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
        `*Note:* The bot fetches data from multiple workspaces simultaneously. Each channel has independent autoruns. By default, it uses today's date. Use /changedate to analyze a different date.`, { parse_mode: 'Markdown' });
});
bot.command('stats', async (ctx) => {
    const userId = ctx.from.id;
    const chatId = getChatId(ctx);
    const session = getOrCreateSession(userId);
    if (isChatProcessing(session, chatId)) {
        return ctx.reply('Please wait, your previous request is still processing...');
    }
    setChatProcessing(session, chatId, true);
    try {
        const args = ctx.message.text.split(' ').slice(1);
        if (args[0] === 'start') {
            const interval = Math.max(parseInt(args[1]) || 5, 1);
            const jobKey = createJobKey('stats', chatId);
            const existingJob = session.autorunJobs.get(jobKey);
            if (existingJob) {
                clearInterval(existingJob.interval);
            }
            await ctx.reply('Fetching statistics from all workspaces...');
            const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, false, session);
            const stats = calculateCampaignStats(calls);
            const text = formatCampaignStats(stats, session.date);
            await ctx.reply(text, { parse_mode: 'Markdown' });
            const job = setInterval(async () => {
                try {
                    const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, false, session);
                    const stats = calculateCampaignStats(calls);
                    const text = formatCampaignStats(stats, session.date);
                    await ctx.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown' });
                }
                catch (error) {
                    console.error('Autorun stats error:', error);
                }
            }, interval * 60 * 1000);
            session.autorunJobs.set(jobKey, { interval: job, chatId, commandName: 'stats' });
            await ctx.reply(`Statistics autorun started (every ${interval} minutes) for date: ${session.date}\nThis autorun is specific to this channel.`);
        }
        else {
            await ctx.reply('Fetching statistics from all workspaces...');
            const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, false, session);
            const stats = calculateCampaignStats(calls);
            const text = formatCampaignStats(stats, session.date);
            await ctx.reply(text, { parse_mode: 'Markdown' });
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
        return ctx.reply('Please wait, your previous request is still processing...');
    }
    setChatProcessing(session, chatId, true);
    try {
        const args = ctx.message.text.split(' ').slice(1);
        if (args[0] === 'start') {
            const interval = Math.max(parseInt(args[1]) || 5, 1);
            const jobKey = createJobKey('viewtfns', chatId);
            const existingJob = session.autorunJobs.get(jobKey);
            if (existingJob) {
                clearInterval(existingJob.interval);
            }
            await ctx.reply('Fetching TFN statistics from all workspaces...');
            const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, false, session);
            const stats = calculateCampaignStats(calls);
            const text = formatTFNStats(stats, session.date);
            await ctx.reply(text, { parse_mode: 'HTML' });
            const job = setInterval(async () => {
                try {
                    const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, false, session);
                    const stats = calculateCampaignStats(calls);
                    const text = formatTFNStats(stats, session.date);
                    await ctx.telegram.sendMessage(chatId, text, { parse_mode: 'HTML' });
                }
                catch (error) {
                    console.error('Autorun viewtfns error:', error);
                }
            }, interval * 60 * 1000);
            session.autorunJobs.set(jobKey, { interval: job, chatId, commandName: 'viewtfns' });
            await ctx.reply(`TFN statistics autorun started (every ${interval} minutes) for date: ${session.date}\nThis autorun is specific to this channel.`);
        }
        else {
            await ctx.reply('Fetching TFN statistics from all workspaces...');
            const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, false, session);
            const stats = calculateCampaignStats(calls);
            const text = formatTFNStats(stats, session.date);
            await ctx.reply(text, { parse_mode: 'HTML' });
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
        return ctx.reply('Please wait, your previous request is still processing...');
    }
    setChatProcessing(session, chatId, true);
    try {
        const args = ctx.message.text.split(' ').slice(1);
        if (args[0] === 'start') {
            const interval = Math.max(parseInt(args[1]) || 15, 1);
            const jobKey = createJobKey('getivr', chatId);
            const existingJob = session.autorunJobs.get(jobKey);
            if (existingJob) {
                clearInterval(existingJob.interval);
            }
            await ctx.reply('Fetching repeat callers from all workspaces...');
            const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, false, session);
            const callerCounts = getRepeatCallers(calls);
            const text = formatRepeatCallers(callerCounts, session.date);
            await ctx.reply(text, { parse_mode: 'Markdown' });
            const job = setInterval(async () => {
                try {
                    const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, false, session);
                    const callerCounts = getRepeatCallers(calls);
                    const text = formatRepeatCallers(callerCounts, session.date);
                    await ctx.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown' });
                }
                catch (error) {
                    console.error('Autorun getivr error:', error);
                }
            }, interval * 60 * 1000);
            session.autorunJobs.set(jobKey, { interval: job, chatId, commandName: 'getivr' });
            await ctx.reply(`Repeat callers autorun started (every ${interval} minutes) for date: ${session.date}\nThis autorun is specific to this channel.`);
        }
        else {
            await ctx.reply('Fetching repeat callers from all workspaces...');
            const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, false, session);
            const callerCounts = getRepeatCallers(calls);
            const text = formatRepeatCallers(callerCounts, session.date);
            await ctx.reply(text, { parse_mode: 'Markdown' });
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
        return ctx.reply('Please wait, your previous request is still processing...');
    }
    setChatProcessing(session, chatId, true);
    try {
        const args = ctx.message.text.split(' ').slice(1);
        if (args[0] === 'start') {
            const interval = Math.max(parseInt(args[1]) || 5, 1);
            const jobKey = createJobKey('flow', chatId);
            const existingJob = session.autorunJobs.get(jobKey);
            if (existingJob) {
                clearInterval(existingJob.interval);
            }
            await ctx.reply('Checking flow from all workspaces...');
            const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, false, session);
            const stats = calculateCampaignStats(calls);
            const totalFlow = calculateTotalFlow(stats);
            let text = `<b>Flow Check (${session.date})</b>\n\n`;
            text += '<b>Campaign Breakdown:</b>\n';
            const sortedStats = Array.from(stats.values()).sort((a, b) => a.name.localeCompare(b.name));
            const maxNameLength = Math.max(...sortedStats.map(s => s.name.replace(/-/g, '').length));
            text += '<pre>';
            sortedStats.forEach(s => {
                const cleanName = s.name.replace(/-/g, '');
                const paddedName = cleanName.padEnd(maxNameLength);
                text += `${paddedName}: ${s.live}\n`;
            });
            text += '</pre>\n';
            text += `<b>Total Flow:</b> ${totalFlow}(live)\n`;
            if (totalFlow < 60) {
                text += '<b>ALERT:</b> Check Flow Kindly';
            }
            await ctx.reply(text, { parse_mode: 'HTML' });
            const job = setInterval(async () => {
                try {
                    const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, false, session);
                    const stats = calculateCampaignStats(calls);
                    const totalFlow = calculateTotalFlow(stats);
                    let text = `<b>Flow Check (${session.date})</b>\n\n`;
                    text += '<b>Campaign Breakdown:</b>\n';
                    const sortedStats = Array.from(stats.values()).sort((a, b) => a.name.localeCompare(b.name));
                    const maxNameLength = Math.max(...sortedStats.map(s => extractCampaignNumber(s.name).length));
                    text += '<pre>';
                    sortedStats.forEach(s => {
                        const campaignDisplay = extractCampaignNumber(s.name);
                        const paddedName = campaignDisplay.padEnd(maxNameLength);
                        text += `${paddedName}: ${s.live}\n`;
                    });
                    text += '</pre>\n';
                    text += `<b>Total Flow:</b>= ${totalFlow}(live)\n`;
                    if (totalFlow < 60) {
                        text += '<b>ALERT:</b> Check Flow Kindly';
                    }
                    await ctx.telegram.sendMessage(chatId, text, { parse_mode: 'HTML' });
                }
                catch (error) {
                    console.error('Autorun flow error:', error);
                }
            }, interval * 60 * 1000);
            session.autorunJobs.set(jobKey, { interval: job, chatId, commandName: 'flow' });
            await ctx.reply(`Flow check autorun started (every ${interval} minutes) for date: ${session.date}\nThis autorun is specific to this channel.`);
        }
        else {
            await ctx.reply('Checking flow from all workspaces...');
            const calls = await fetchAllCallsFromMultipleWorkspaces(WORKSPACES, session.date, false, session);
            const stats = calculateCampaignStats(calls);
            const totalFlow = calculateTotalFlow(stats);
            let text = `<b>Flow Check (${session.date})</b>\n\n`;
            text += '<b>Campaign Breakdown:</b>\n';
            const sortedStats = Array.from(stats.values()).sort((a, b) => a.name.localeCompare(b.name));
            const maxNameLength = Math.max(...sortedStats.map(s => s.name.replace(/-/g, '').length));
            text += '<pre>';
            sortedStats.forEach(s => {
                const cleanName = s.name.replace(/-/g, '');
                const paddedName = cleanName.padEnd(maxNameLength);
                text += `${paddedName}: ${s.live}\n`;
            });
            text += '</pre>\n';
            text += `<b>Total Flow:</b> ${totalFlow}(live)\n`;
            if (totalFlow < 60) {
                text += '<b>ALERT:</b> Check Flow Kindly';
            }
            await ctx.reply(text, { parse_mode: 'HTML' });
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
            await ctx.reply(`Date filter updated to: *${text}*\n\n` +
                `Available commands:\n` +
                `• /stats [start INTERVAL] - Campaign statistics\n` +
                `• /viewtfns [start INTERVAL] - View TFN statistics with AHT\n` +
                `• /getivr [start INTERVAL] - View repeat callers\n` +
                `• /flow [start INTERVAL] - Check total flow\n` +
                `• /changedate - Change date filter\n` +
                `• /stopauto - Stop autoruns in this channel\n` +
                `• /help - Show help`, { parse_mode: 'Markdown' });
        }
        catch (error) {
            await ctx.reply('Invalid date format. Please use YYYY-MM-DD format.\nExample: 2025-11-26');
        }
    }
});
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
const startServer = async () => {
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
    });
    await bot.launch();
    console.log('Bot is running in polling mode');
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
};
startServer().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map