#!/usr/bin/env node
// Confirms that one published version went live on the VS Code Marketplace.
//
// `vsce publish` returns as soon as the upload is accepted, while the
// marketplace still shows "Verifying" and the version is not installable. This
// asks about that one version until it appears — and does so sparingly.
//
// Politeness is the point. An earlier version polled the gallery query API
// every 30s for up to an hour (120 requests per release), starting immediately
// even though validation takes about five minutes, and pulled back every
// version of the extension each time to look at one. Several releases in a day
// was enough for marketplace.visualstudio.com to start answering "The request
// is blocked", so:
//
//   - nothing is asked for the first DELAY_SECONDS, since nothing can be live;
//   - each check is a HEAD for this exact version's .vsix, not a listing;
//   - ATTEMPTS is a hard cap, so one release can never make more than that;
//   - a block or rate-limit ends the wait instead of retrying into it.
//
// Verification is a courtesy, not the release: by the time this runs the
// publish has already succeeded. "Could not confirm" is therefore a soft
// failure (exit 1) for the caller to report, never a reason to keep knocking.
//
// Usage: node scripts/wait-for-marketplace.mjs <publisher.extension> <version>
// Env:   DELAY_SECONDS (default 300), INTERVAL_SECONDS (default 60),
//        ATTEMPTS (default 10)

const [extensionId, version] = process.argv.slice(2);
if (!extensionId || !version) {
	console.error('usage: wait-for-marketplace.mjs <publisher.extension> <version>');
	process.exit(2);
}

const [publisher, name] = extensionId.split('.');
if (!publisher || !name) {
	console.error(`expected <publisher.extension>, got "${extensionId}"`);
	process.exit(2);
}

const delayMs = Number(process.env.DELAY_SECONDS ?? 300) * 1000;
const intervalMs = Number(process.env.INTERVAL_SECONDS ?? 60) * 1000;
const attempts = Number(process.env.ATTEMPTS ?? 10);

// The version's own package. It exists only once that version is validated, so
// its status code is the whole answer and the body is never downloaded.
const vsix = 'https://marketplace.visualstudio.com/_apis/public/gallery'
	+ `/publishers/${publisher}/vsextensions/${name}/${version}/vspackage`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** `live` once the version is downloadable, `pending` until then, `blocked` when we are being turned away. */
async function check() {
	const response = await fetch(vsix, { method: 'HEAD', redirect: 'manual' });
	const status = response.status;
	// A published version answers 200, or redirects to wherever the package is
	// actually served from; an unpublished one is a plain 404.
	if (status >= 200 && status < 400) { return { state: 'live', status }; }
	if (status === 404) { return { state: 'pending', status }; }
	return { state: 'blocked', status };
}

console.log(`Waiting ${Math.round(delayMs / 1000)}s before the first check — validation takes about five minutes.`);
await sleep(delayMs);

for (let attempt = 1; attempt <= attempts; attempt++) {
	let result;
	try {
		result = await check();
	} catch (error) {
		// A network-level failure says nothing about the release; one retry's
		// worth of patience, still inside the attempt cap.
		console.log(`attempt ${attempt}/${attempts}: ${error.message}`);
		if (attempt < attempts) { await sleep(intervalMs); }
		continue;
	}

	if (result.state === 'live') {
		console.log(`${extensionId}@${version} is live (HTTP ${result.status}).`);
		process.exit(0);
	}

	if (result.state === 'blocked') {
		console.error(`Marketplace answered HTTP ${result.status} — stopping rather than retrying into a block.`);
		console.error(`${extensionId}@${version} was published; its listing could not be confirmed from here.`);
		process.exit(1);
	}

	console.log(`attempt ${attempt}/${attempts}: ${version} not listed yet.`);
	if (attempt < attempts) { await sleep(intervalMs); }
}

console.error(`Gave up after ${attempts} checks; ${version} is published but still verifying.`);
process.exit(1);
