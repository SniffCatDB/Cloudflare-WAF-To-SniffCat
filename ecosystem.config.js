module.exports = {
	apps: [{
		name: 'cf-sniffcat',
		script: './index.js',

		// Logging settings
		log_date_format: 'HH:mm:ss.SSS DD.MM.YYYY',
		merge_logs: true,
		log_file: '~/logs/other/cf-waf-to-sniffcat/combined.log',
		out_file: '~/logs/other/cf-waf-to-sniffcat/out.log',
		error_file: '~/logs/other/cf-waf-to-sniffcat/error.log',

		// Application restart policy
		wait_ready: true,
		autorestart: true,
		max_restarts: 4,
		restart_delay: 4000,
		min_uptime: 3000,

		// Environment variables
		env: {
			NODE_ENV: 'production',
		},
	}],
};