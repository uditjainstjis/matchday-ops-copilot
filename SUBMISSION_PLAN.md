# PromptWars Virtual — Challenge 4

**DEADLINE: 2026-07-19 23:59 IST. Under 2h40m at time of writing.**

## The competition

- Hack2skill × Google for Developers, **India only**
- Challenge 4: **"Smart Stadiums & Tournament Operations"** (FIFA World Cup 2026 theme)
- Window: 6 Jul → 19 Jul 2026
- **42,849 participants.** Udit currently rank #11818 — i.e. unranked, no submission yet
- **Attempts: 0 of 3 used.** Only the *last* attempt counts on the leaderboard, so early submission then improvement is strictly better than one late shot
- Dashboard: https://hack2skill.com/event/pwvirtual1/dashboard/submissions

## How it is scored — the decisive detail

Submissions are **evaluated by an AI reading the GitHub repository**, on exactly six criteria:

**Code Quality · Security · Efficiency · Testing · Accessibility · Problem Statement Alignment**

This is a rubric, not a novelty contest. That's very favourable — it rewards exactly the things that are cheap for us to do well and that most of a 42,849-person field will skip. **Accessibility in particular is near-free differentiation**: almost nobody ships WCAG-compliant hackathon code.

## Hard requirements

| Field | Status |
|---|---|
| **Public GitHub repo** (<10 MB) | ✅ `gh` authenticated as `uditjainstjis` with repo scope |
| **Deployed link** | 🔄 building — Cloudflare Workers, account authenticated |
| **LinkedIn post** tagging Hack2skill + Google for Developers | ⚠️ **needs Udit** — see below |
| **Gen AI mandatory** | ✅ Cloudflare Workers AI (free tier, no API key needed) |

## Gen-AI provider decision

No GCP credits and no paid API keys exist, and the dashboard states plainly: *"NO GCP CREDITS WILL BE PROVIDED. YOU CAN USE ANY AI TOOL TO BUILD & DEPLOY."*

So the build uses **Cloudflare Workers AI** — free tier, works on the already-authenticated account, no key to leak or expire. Designing around an API key we don't have would make the deployed demo dead on arrival, which fails the "operational Gen AI" requirement outright.

## The one blocker: the LinkedIn post

A LinkedIn verification post is a **mandatory submission field**. LinkedIn is signed in as Udit, so it is technically possible — but it publishes to his professional profile, so it needs his explicit go-ahead rather than being done silently.

Draft ready to post the moment the app is live (final version will include the real app link):

> Just shipped my Challenge 4 build for PromptWars: Virtual — a Smart Stadiums & Tournament Operations tool for the 2026 World Cup.
>
> [one line on what it does]
>
> Built with Cloudflare Workers AI, deployed on Workers. Fully accessible (WCAG 2.2 AA), tested, and open source.
>
> Live: [url]
> Code: [repo]
>
> Thanks @Hack2skill and @Google for Developers for the challenge.
> #PromptWars #BuildWithAI #GenAI

## Status

Build workflow running: build → deploy → four parallel adversarial hardening passes, one per scoring criterion, each of which fixes what it finds rather than just reporting.
