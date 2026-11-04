# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The backend of a digital waiting list for busy restaurants. Staff replace the paper list; guests join
by scanning a rotating QR code at the restaurant. This repository is public and is written by Deepa,
one plan session at a time. **Claude explains, reviews ("check my 7a") and answers questions; it
writes backend code only when Deepa asks for that piece.**

## Two repositories, one product

| Repository | Holds | Written by |
|---|---|---|
| `waitlist-api` (this one, public) | Lambda handlers, `infra/template.yaml` (SAM), tests, **`docs/design.md` (the backend design)**, **`docs/api.md` (the master contract)** | Deepa |
| `Waitlist` (private) | the React frontend, the private product notes (business numbers, open questions), frontend defects | Claude |

**This repository is public, so a session here works only inside this folder.** It has no access to
the private frontend repo or any other folder. What the backend needs is in this repository.

- **The design is `docs/design.md`**, the master copy. Read the section a session needs before
  reviewing or explaining: §3 architecture and compatibility rules, §4 live updates and the ETA rule,
  §5 rotating QR, §6 data model, §7 staff app and CSRF, §8 allocation rule, §9 concurrency, §10 hold and
  release, §11 events, §12 privacy, §13 cost, §15 WhatsApp. (§14, open product questions, is private.)
  A changed decision is written there in the same session.
- **The schedule is the plan page** (an artifact; the link is in Claude's memory). Never make a second plan file.
- **`docs/api.md` here is the only master copy of the contract.** The frontend repo's `docs/api.md` is a pointer to it.

## Keeping the frontend in sync (the rule)

A contract change starts here and finishes in the frontend repo:
1. **Here:** change `docs/api.md` and the backend code. Commit and push.
2. **In a session started from the frontend repo** (which may read this one): Claude updates
   `web/src/types.ts`, `web/src/mock/mock.ts` and any page that reads the changed field; Deepa runs
   `npm run build:web` and `npm run e2e` there.

End a session that changed `docs/api.md` by saying so, so the frontend step is not forgotten.
Compatibility rules (design.md §3): responses only grow, add before you remove, the API deploys before the frontend.

**Behaviour the frontend already relies on** (the backend must match it, and the mock shows it):
- Every staff action returns the full board; `GET /api/staff/board` and the guest status take `?v=` and answer `304` when `queue_version` is unchanged.
- The board carries `now` (server time). The frontend corrects the device clock with it, so `heldUntil`, `stateSince` and `joinedAt` must be server times in UTC.
- Errors are `{ code, message }`. The page shows its own text per `code` (English or Tamil), so a new error needs a new code, and the frontend needs its text.
- Create requests carry `idempotencyKey`; the same key again returns the first answer.
- Phone rule: see `POST /api/join/...` in `docs/api.md` (exactly 10 digits, `^[6-9][0-9]{9}$`, else `400 BAD_INPUT`; nothing is stripped or repaired).
- Writes (POST, PATCH, DELETE) arrive with `x-amz-content-sha256`: CloudFront OAC signs the request but does not hash the body.
- Frontend-side checks (`web/src/lib/validate.ts`) only give a clearer message first; the server checks everything again.

## Architecture (design.md §3, decided 9 Oct; two repos decided 30 Oct)

- **API:** one Lambda (arm64, Node 24) with a Function URL (`AuthType AWS_IAM`) behind CloudFront. No API Gateway.
- **Database:** Postgres. Local PostgreSQL 15 for development, Neon free tier (pooled string) when hosted.
- **Push sender and WhatsApp sender:** Lambdas on one SQS standard queue (messages carry `"version": 1`).
- **WhatsApp webhook:** a second Lambda with its own public Function URL (`AuthType NONE`), checked by `x-hub-signature-256`.
- **Outbox sweeper, integrity job, hold expiry, daily stats:** Lambdas on EventBridge schedules.
- **Local development:** the same handlers behind a small `node:http` server, against local Postgres.
- **Deploy:** `sam build` + `sam deploy`, one CloudFormation stack.

**Layout** (from session 7a): `src/domain` (pure rules, no imports from the other folders), `src/application`
(use cases, transactions), `src/infrastructure` (Postgres, SQS, push), `src/interfaces` (Lambda and
`node:http` adapters). Handlers stay thin, so the same code runs in Lambda, locally and in tests.

## Conventions

- The domain word is **"group"**, never "party". The table is `groups` (`group` is an SQL reserved word); push-together tables are a **"combine set"**.
- The database, logs and server `message`s are **English only**. Only the frontend translates, by `code`.
- Races are settled by the database: conditional `UPDATE ... WHERE state = 'free'` and a row-count check (design.md §9), with constraints and partial unique indexes for the invariants (§6).
- Every state change bumps `queue_version` and writes one `outbox` row in the same transaction.
- Allocation is a rule, not AI (§8). AI only predicts (the ETA) and explains.
- TypeScript strict. Node 24 runs `.ts` by stripping the types, so use `erasableSyntaxOnly` (no `enum`, `namespace` or parameter properties) and import with `.ts` extensions.
- Tests use **Vitest** (decided 4 Nov): Jest-style `describe`/`it`/`expect`, and it runs ESM + TypeScript with `.ts` imports without a transform. Jest was rejected (needs a transform and experimental ESM flags). Tests live in a separate `test/` folder that mirrors `src/` (`test/domain/phone.test.ts` tests `src/domain/phone.ts`); integration tests that need Postgres go in `test/integration/`. `tsconfig` includes both `src` and `test`. Domain rules take `now` and random values as arguments, so tests need no fake timers.
- **Zero rupees in AWS** (§13): Lambda, SQS, EventBridge, CloudFront, standard Parameter Store, basic CloudWatch. The only paid exception is S3 under ₹1 a month. Never create a NAT gateway, ALB, RDS, EC2, public IPv4, interface endpoint, customer-managed KMS key or API Gateway.
- No containers: the development machine cannot run Docker, Podman or kind.
- Secrets never go in Git: `.env` locally (gitignored), Parameter Store when hosted.

## Commands

None yet. Session 7a adds `package.json`, the type check and `vitest run`, and CI.
