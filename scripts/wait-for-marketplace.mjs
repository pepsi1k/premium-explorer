#!/usr/bin/env node
// Polls the VS Code Marketplace gallery API until a version is validated.
//
// `vsce publish` returns as soon as the upload is accepted, while the
// marketplace still shows "Verifying" and the version is not installable.
// The public gallery API lists validated versions only, so a version
// appearing there is an exact signal that it went live.
//
// Usage: node scripts/wait-for-marketplace.mjs <publisher.extension> <version>
// Env:   TIMEOUT_SECONDS (default 900), INTERVAL_SECONDS (default 20)

const GALLERY = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';

const [extensionId, version] = process.argv.slice(2);
if (!extensionId || !version) {
	console.error('usage: wait-for-marketplace.mjs <publisher.extension> <version>');
	process.exit(2);
}

const timeoutMs = Number(process.env.TIMEOUT_SECONDS ?? 900) * 1000;
const intervalMs = Number(process.env.INTERVAL_SECONDS ?? 20) * 1000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function publishedVersions() {
	const response = await fetch(GALLERY, {
		method: 'POST',
		headers: {
			'Accept': 'application/json;api-version=3.0-preview.1',
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			filters: [{
				criteria: [{ filterType: 7, value: extensionId }],
				pageNumber: 1,
				pageSize: 100,
			}],
			flags: 1, // IncludeVersions
		}),
	});

	if (!response.ok) {
		throw new Error(`gallery API returned ${response.status} ${response.statusText}`);
	}

	const extension = (await response.json())?.results?.[0]?.extensions?.[0];
	if (!extension) {
		return [];
	}

	return (extension.versions ?? [])
		.filter(candidate => String(candidate.flags ?? '').includes('validated'))
		.map(candidate => candidate.version);
}

const startedAt = Date.now();
let attempt = 0;

while (true) {
	attempt++;
	const elapsed = Math.round((Date.now() - startedAt) / 1000);

	let versions;
	try {
		versions = await publishedVersions();
	} catch (error) {
		// A transient gallery error should not end the wait; only the clock does.
		console.log(`[${elapsed}s] attempt ${attempt}: ${error.message}`);
		await sleep(intervalMs);
		continue;
	}

	if (versions.includes(version)) {
		console.log(`[${elapsed}s] ${extensionId}@${version} is validated and live.`);
		process.exit(0);
	}

	console.log(`[${elapsed}s] attempt ${attempt}: ${version} not live yet (published: ${versions.join(', ') || 'none'})`);

	if (Date.now() - startedAt + intervalMs > timeoutMs) {
		console.error(`Timed out after ${Math.round(timeoutMs / 1000)}s; ${version} is still verifying.`);
		process.exit(1);
	}

	await sleep(intervalMs);
}
