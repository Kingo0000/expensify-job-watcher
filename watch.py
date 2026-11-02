#!/usr/bin/env python3
"""Check Expensify/App for newly opened paid "Help Wanted" issues and alert on Telegram.

Runs once per invocation (GitHub Actions calls it on a schedule). Already-seen issue
numbers live in seen.json, which the workflow commits back to the repo.

Env: GITHUB_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, optional TEST=1.
"""
import html
import json
import os
import re
import urllib.parse
import urllib.request
from pathlib import Path

REPO = "Expensify/App"
STATE = Path(__file__).with_name("seen.json")
PROPOSAL_RE = re.compile(r"^#+\s*Proposal", re.M)


def github(path):
    """GET every page of a GitHub API list endpoint."""
    url = f"https://api.github.com/{path}"
    items = []
    while url:
        req = urllib.request.Request(url, headers={
            "Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
            "Accept": "application/vnd.github+json",
        })
        with urllib.request.urlopen(req, timeout=30) as resp:
            items += json.load(resp)
            match = re.search(r'<([^>]+)>;\s*rel="next"', resp.headers.get("Link", ""))
            url = match.group(1) if match else None
    return items


def open_jobs():
    query = urllib.parse.urlencode({"labels": "Help Wanted", "state": "open", "per_page": 100})
    return [i for i in github(f"repos/{REPO}/issues?{query}") if "pull_request" not in i]


def proposal_count(number):
    comments = github(f"repos/{REPO}/issues/{number}/comments?per_page=100")
    return sum(1 for c in comments if PROPOSAL_RE.search(c.get("body") or ""))


def price(title):
    match = re.search(r"\[\$(\d+)\]", title)
    return f"${match.group(1)}" if match else "$?"


def telegram(text):
    data = urllib.parse.urlencode({
        "chat_id": os.environ["TELEGRAM_CHAT_ID"],
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": "true",
    }).encode()
    url = f"https://api.telegram.org/bot{os.environ['TELEGRAM_BOT_TOKEN']}/sendMessage"
    urllib.request.urlopen(url, data=data, timeout=30).read()


def main():
    if os.environ.get("TEST") == "1":
        jobs = open_jobs()
        telegram(f"✅ Expensify watcher is live. {len(jobs)} jobs open right now; "
                 "you'll get a message the moment a new one appears.")
        return

    try:
        seen = set(json.loads(STATE.read_text()))
    except (FileNotFoundError, ValueError):
        seen = set()
    first_run = not seen

    for job in open_jobs():
        if job["number"] in seen:
            continue
        seen.add(job["number"])
        if first_run:
            continue
        n = proposal_count(job["number"])
        telegram(
            f"💰 <b>{price(job['title'])} Expensify job</b> · {n} proposals so far\n"
            f"{html.escape(job['title'])}\n{job['html_url']}"
        )
        print(f"alerted #{job['number']} ({n} proposals)")

    STATE.write_text(json.dumps(sorted(seen)) + "\n")
    if first_run:
        print(f"first run: recorded {len(seen)} open jobs without alerting")


if __name__ == "__main__":
    main()
