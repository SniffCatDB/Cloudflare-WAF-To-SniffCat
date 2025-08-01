//   Copyright 2025 © by Sefinek. All Rights Reserved.
//                https://sefinek.net

const { CronJob } = require('cron');
const banner = require('./scripts/banners/cloudflare.js');
const { repoSlug, repoUrl } = require('./scripts/repo.js');
const { axios } = require('./scripts/services/axios.js');
const { refreshServerIPs, getServerIPs } = require('./scripts/services/ipFetcher.js');
const { saveBufferToFile, loadBufferFromFile, sendBulkReport, BULK_REPORT_BUFFER } = require('./scripts/services/bulk.js');
const PAYLOAD = require('./scripts/services/cloudflare/generateFirewallQuery.js');
const SefinekAPI = require('./scripts/services/cloudflare/reportToSefinek.js');
const headers = require('./scripts/headers.js');
const { logToCSV, readReportedIPs } = require('./scripts/services/cloudflare/csv.js');
const getFilters = require('./scripts/services/cloudflare/getFilterRules.js');
require('./scripts/cliHelp.js');
const logger = require('./scripts/logger.js');
const { MAIN, GENERATE_COMMENT } = require('./config.js');

const ABUSE_STATE = { isLimited: false, isBuffering: false, sentBulk: false };
const RATE_LIMIT_LOG_INTERVAL = 10 * 60 * 1000;
const BUFFER_STATS_INTERVAL = 5 * 60 * 1000;
let cycleId = 1;

const nextRateLimitReset = () => {
	const now = new Date();
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 1));
};

let LAST_RATELIMIT_LOG = 0, LAST_STATS_LOG = 0, RATELIMIT_RESET = nextRateLimitReset();

const checkRateLimit = async () => {
	const now = Date.now();
	if (now - LAST_STATS_LOG >= BUFFER_STATS_INTERVAL && BULK_REPORT_BUFFER.size > 0) LAST_STATS_LOG = now;

	if (ABUSE_STATE.isLimited) {
		if (now >= RATELIMIT_RESET.getTime()) {
			ABUSE_STATE.isLimited = false;
			ABUSE_STATE.isBuffering = false;
			if (!ABUSE_STATE.sentBulk && BULK_REPORT_BUFFER.size > 0) await sendBulkReport();
			RATELIMIT_RESET = nextRateLimitReset();
			ABUSE_STATE.sentBulk = false;
			logger.log(`Rate limit reset. Next reset scheduled at ${RATELIMIT_RESET.toISOString()}`, 1);
		} else if (now - LAST_RATELIMIT_LOG >= RATE_LIMIT_LOG_INTERVAL) {
			const minutesLeft = Math.ceil((RATELIMIT_RESET.getTime() - now) / 60000);
			logger.log(`Rate limit is still active. Collected ${BULK_REPORT_BUFFER.size} IPs. Waiting for reset in ${minutesLeft} minute(s) (${RATELIMIT_RESET.toISOString()})`, 1);
			LAST_RATELIMIT_LOG = now;
		}
	}
};

const fetchCloudflareEvents = async whitelist => {
	if (MAIN.CLOUDFLARE_ZONE_IDS && MAIN.CLOUDFLARE_ZONE_ID) {
		logger.log('Both CLOUDFLARE_ZONE_IDS and deprecated CLOUDFLARE_ZONE_ID are defined. Using CLOUDFLARE_ZONE_IDS.', 1);
	}

	const rawZoneIds = MAIN.CLOUDFLARE_ZONE_IDS || MAIN.CLOUDFLARE_ZONE_ID;
	const zoneIds = Array.isArray(rawZoneIds) ? rawZoneIds : [rawZoneIds];
	const allEvents = [];

	for (const zoneId of zoneIds) {
		try {
			const { data, status } = await axios.post('https://api.cloudflare.com/client/v4/graphql', PAYLOAD(1000, zoneId), headers.CLOUDFLARE);

			const events = data?.data?.viewer?.zones?.[0]?.firewallEventsAdaptive;
			if (!events) throw new Error(`Failed to retrieve data from Cloudflare (status ${status}): ${JSON.stringify(data?.errors)}`);

			allEvents.push(...events);
		} catch (err) {
			logger.log(err.response?.data ? `${err.response.status} HTTP ERROR for zone ${zoneId}: ${JSON.stringify(err.response.data, null, 2)}` : `Unknown error for zone ${zoneId}: ${err.message}`, 3);
		}
	}

	const isWhitelisted = event =>
		getServerIPs().includes(event.clientIP) ||
		whitelist.userAgents.some(ua => event.userAgent.includes(ua)) ||
		whitelist.imgExtensions.some(ext => event.clientRequestPath.endsWith(ext)) ||
		whitelist.domains.some(domain => event.clientRequestHTTPHost.includes(domain)) ||
		whitelist.endpoints.some(endpoint => event.clientRequestPath.includes(endpoint));

	const filtered = allEvents.filter(event => event.source === 'l7ddos' || !isWhitelisted(event));
	logger.log(`Fetched ${allEvents.length} Cloudflare events (${filtered.length} matching filter criteria) `, 1);
	return filtered;
};

const reportIP = async (event, categories, comment) => {
	await checkRateLimit();

	if (ABUSE_STATE.isBuffering) {
		if (!BULK_REPORT_BUFFER.has(event.clientIP)) {
			BULK_REPORT_BUFFER.set(event.clientIP, { categories, timestamp: event.datetime, comment });
			await saveBufferToFile();
			logger.log(`Queued ${event.clientIP} for bulk report (collected ${BULK_REPORT_BUFFER.size} IPs)`, 1);
			return { success: false, code: 'READY_FOR_BULK_REPORT' };
		}
		return { success: false, code: 'ALREADY_IN_BUFFER' };
	}

	try {
		await axios.post('/report', new URLSearchParams({
			ip: event.clientIP,
			categories,
			comment,
			timestamp: event.datetime,
		}), headers.SNIFFCAT);

		logger.log(`Reported ${event.clientIP}; URI: ${event.clientRequestPath}`, 1);
		return { success: true, code: 'REPORTED' };
	} catch (err) {
		const status = err.response?.status ?? 'unknown';
		if (status === 429 && JSON.stringify(err.response?.data || {}).includes('Daily rate limit')) {
			if (!ABUSE_STATE.isLimited) {
				ABUSE_STATE.isLimited = true;
				ABUSE_STATE.isBuffering = true;
				ABUSE_STATE.sentBulk = false;
				LAST_RATELIMIT_LOG = Date.now();
				RATELIMIT_RESET = nextRateLimitReset();
				logger.log(`Daily SniffCat limit reached. Buffering reports until ${RATELIMIT_RESET.toLocaleString()}`, 0, true);
			}

			if (!BULK_REPORT_BUFFER.has(event.clientIP)) {
				BULK_REPORT_BUFFER.set(event.clientIP, { timestamp: event.datetime, categories, comment });
				await saveBufferToFile();
				logger.log(`Queued ${event.clientIP} for bulk report due to rate limit`, 1);
				return { success: false, code: 'RL_BULK_REPORT' };
			}

			return { success: false, code: 'ALREADY_IN_BUFFER' };
		}

		logger.log(`Failed to report ${event.clientIP}; ${err.response?.data?.errors ? JSON.stringify(err.response.data.errors) : err.message}`, status === 429 ? 0 : 3);
		return { success: false, code: 'FAILED' };
	}
};

const knownStatuses = new Set(['TOO_MANY_REQUESTS', 'REPORTED', 'READY_FOR_BULK_REPORT', 'RL_BULK_REPORT']);
const isIPReportedRecently = (event, reportedIPs) => {
	const now = Date.now();
	return reportedIPs.some(entry =>
		(entry.ip === event.clientIP || entry.rayId === event.rayName) &&
		knownStatuses.has(entry.status) &&
		(now - entry.timestamp) < MAIN.IP_REPORT_COOLDOWN
	) ? { recentlyReported: true } : { recentlyReported: false };
};

const processData = async () => {
	logger.log(`====================== STARTING REPORTING CYCLE #${cycleId} ======================`);

	// IP refresh
	await refreshServerIPs();
	const ips = getServerIPs();
	if (!Array.isArray(ips)) return logger.log(`getServerIPs() returned an invalid result: ${ips}`, 3);

	// Cache
	const [whitelist, reportedIPs] = await Promise.all([
		getFilters(),
		readReportedIPs(),
	]);

	// Fetch events
	const reportedIPsSet = new Set(reportedIPs.map(e => e.ip));
	const events = await fetchCloudflareEvents(whitelist);
	if (!events?.length) {
		return logger.log('No events fetched from Cloudflare. Skipping this cycle.');
	}

	// Report IPs
	let cycleErrorCounts = 0, cycleProcessedCount = 0, cycleReportedCount = 0, cycleSkippedCount = 0;
	for (const event of events) {
		cycleProcessedCount++;

		const { clientIP, clientRequestPath } = event;
		if (
			ips.includes(clientIP) ||
			whitelist.endpoints.includes(clientRequestPath) ||
			clientRequestPath.length > MAIN.MAX_URL_LENGTH ||
			reportedIPsSet.has(clientIP) ||
			isIPReportedRecently(event, reportedIPs).recentlyReported
		) {
			cycleSkippedCount++;
			continue;
		}

		const categories = event.source === 'l7ddos' ? '3,21' : '15,21';
		const result = await reportIP(event, categories, GENERATE_COMMENT(event));

		await logToCSV(event, result.code);

		if (['REPORTED', 'RL_BULK_REPORT', 'READY_FOR_BULK_REPORT'].includes(result.code)) {
			reportedIPsSet.add(clientIP);
		}

		if (result.success) {
			cycleReportedCount++;
			await new Promise(res => setTimeout(res, MAIN.SUCCESS_COOLDOWN));
			continue;
		}

		if (result.code === 'FAILED' || !['ALREADY_IN_BUFFER', 'READY_FOR_BULK_REPORT', 'RL_BULK_REPORT'].includes(result.code)) cycleErrorCounts++;
	}

	logger.log(`Summary » Processed: ${cycleProcessedCount}; Reported: ${cycleReportedCount}; Skipped: ${cycleSkippedCount}; Errors: ${cycleErrorCounts}`);
	logger.log(`====================== REPORTING CYCLE #${cycleId} COMPLETED ======================`);
	cycleId++;
};

(async () => {
	banner();

	// Auto updates
	if (MAIN.AUTO_UPDATE_ENABLED && MAIN.AUTO_UPDATE_SCHEDULE && MAIN.SERVER_ID !== 'development') {
		await require('./scripts/services/updates.js');
	} else {
		await require('./scripts/services/version.js');
	}

	// Bulk Report
	await loadBufferFromFile();
	if (BULK_REPORT_BUFFER.size > 0 && !ABUSE_STATE.isLimited) {
		logger.log(`Found ${BULK_REPORT_BUFFER.size} IPs in buffer after restart. Sending bulk report...`);
		await sendBulkReport();
	}

	// Sefinek API
	if (MAIN.SEFIN_API_REPORTING && MAIN.SEFIN_API_SECRET_TOKEN && MAIN.SEFIN_API_REPORT_SCHEDULE) {
		new CronJob(MAIN.SEFIN_API_REPORT_SCHEDULE, SefinekAPI, null, true);
	}

	const runSefinekAPI = process.argv.includes('--report-to-sapi');
	if (runSefinekAPI) await SefinekAPI();

	// Report Schedule
	new CronJob(MAIN.REPORT_SCHEDULE, processData, null, true);

	// Ready
	await logger.webhook(`[${repoSlug}](${repoUrl}) was successfully started!`, 0x59D267);
	logger.log(`All set! ${MAIN.RUN_ON_START ? 'Starting first cycle shortly' : 'Waiting for the first scheduled cycle'}...`, 1);
	process.send?.('ready');

	// Run on start?
	if (MAIN.RUN_ON_START || process.argv.includes('--run-on-start')) await processData();
})();