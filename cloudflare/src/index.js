// Cloudflare Worker: every couple of minutes, look for newly opened paid "Help Wanted"
// issues on Expensify/App and send a Telegram alert. Seen issue numbers live in KV.
//
// Secrets: GITHUB_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.  KV binding: STATE.

const REPO = 'Expensify/App';
const PROPOSAL_RE = /^#+\s*Proposal/m;

async function github(env, path) {
    const items = [];
    let url = `https://api.github.com/${path}`;
    while (url) {
        const res = await fetch(url, {
            headers: {
                Authorization: `Bearer ${env.GITHUB_TOKEN}`,
                Accept: 'application/vnd.github+json',
                'User-Agent': 'expensify-job-watcher',
            },
        });
        if (!res.ok) throw new Error(`GitHub ${res.status} on ${path}`);
        items.push(...(await res.json()));
        url = (res.headers.get('Link') || '').match(/<([^>]+)>;\s*rel="next"/)?.[1];
    }
    return items;
}

async function openJobs(env) {
    const issues = await github(env, `repos/${REPO}/issues?labels=Help%20Wanted&state=open&per_page=100`);
    return issues.filter((i) => !i.pull_request);
}

async function proposalCount(env, number) {
    const comments = await github(env, `repos/${REPO}/issues/${number}/comments?per_page=100`);
    return comments.filter((c) => PROPOSAL_RE.test(c.body || '')).length;
}

const price = (title) => title.match(/\[\$(\d+)\]/)?.[0].slice(1, -1) ?? '$?';
const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function telegram(env, text) {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true}),
    });
    if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
}

async function check(env) {
    const seen = new Set(JSON.parse((await env.STATE.get('seen')) || '[]'));
    const firstRun = seen.size === 0;
    const alerted = [];

    for (const job of await openJobs(env)) {
        if (seen.has(job.number)) continue;
        seen.add(job.number);
        if (firstRun) continue;
        const n = await proposalCount(env, job.number);
        await telegram(env, `💰 <b>${price(job.title)} Expensify job</b> · ${n} proposals so far\n${escape(job.title)}\n${job.html_url}`);
        alerted.push(job.number);
    }

    await env.STATE.put('seen', JSON.stringify([...seen].sort((a, b) => a - b)));
    return {firstRun, tracked: seen.size, alerted};
}

// Setting KV key "test" to "1" makes the next scheduled run send a test message.
async function sendTestIfRequested(env) {
    if ((await env.STATE.get('test')) !== '1') return;
    await env.STATE.delete('test');
    const jobs = await openJobs(env);
    await telegram(env, `✅ Expensify watcher is live on Cloudflare. ${jobs.length} jobs open right now; you'll get a message the moment a new one appears.`);
}

export default {
    async scheduled(_event, env, ctx) {
        ctx.waitUntil(
            (async () => {
                try {
                    await sendTestIfRequested(env);
                    console.log(JSON.stringify(await check(env)));
                } catch (error) {
                    await env.STATE.put('lastError', `${new Date().toISOString()} ${error.message}`);
                    throw error;
                }
            })(),
        );
    },
};
