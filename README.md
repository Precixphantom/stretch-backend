# Stretch API

Backend for **Stretch**: a student budget ("Safe to Spend Today") plus **Roommate Kitty**, which splits shared household costs between roommates.

- Node.js 22.9+ (24 recommended) with Express 5
- PostgreSQL (plain SQL with the `pg` driver, versioned migrations)
- Sign in with Google only. There are no passwords.
- Request validation with `zod`

## Getting started

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a database. With a local PostgreSQL:

   ```bash
   createdb -U postgres stretch
   ```

3. Configure `.env`. Copy `.env.example` to `.env` if you don't have one yet, then set:
   - `DATABASE_URL`: your Postgres connection string
   - `GOOGLE_CLIENT_ID`: see [Google setup](#google-setup)
   - `JWT_SECRET`: at least 32 random characters

4. Create the tables:

   ```bash
   npm run db:migrate
   ```

5. Run it:

   ```bash
   npm run dev     # restarts on file changes
   npm start       # production
   npm test        # unit tests
   ```

   Check <http://localhost:4000/health>. It should report `"database": "connected"`.

## Project structure

```text
migrations/              Numbered SQL files, applied in order by `npm run db:migrate`
scripts/migrate.js       Migration runner: applies new files, records them in schema_migrations
src/
  server.js              Entry point: starts the HTTP server, shuts down cleanly
  app.js                 Express app: middleware and route mounting
  config.js              Reads and checks environment variables
  db.js                  Postgres pool, type parsers, withTransaction()
  lib/                   Small shared helpers: errors, dates, today, categories, validation
  middleware/            requireAuth, 404 and error handlers
  modules/               One folder per feature: *.routes.js handles HTTP, *.service.js holds logic and SQL
    auth/                Google sign-in, session tokens
    users/               The signed-in user and their reminder setting
    budget/              Budget periods and the demo scenarios
    transactions/        Personal expenses and income, with filters and search
    insights/            Safe to Spend summary, dashboard and analytics (port of lib/budget-calculations.ts)
    room/                Roommate Kitty: room, invites, shared expenses, settlements
test/                    Unit tests (node:test)
```

To change the schema later, add `migrations/002_something.sql` and run `npm run db:migrate`. Never edit a migration that has already run.

## Google setup

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create an **OAuth client ID** of type **Web application**.
2. Under **Authorized JavaScript origins**, add every frontend origin, for example `http://localhost`, `http://localhost:3000` and your production URL. No redirect URI is needed.
3. Configure the OAuth consent screen (app name, support email).
4. Put the client ID in this API's `GOOGLE_CLIENT_ID` and in the frontend, for example as `NEXT_PUBLIC_GOOGLE_CLIENT_ID`. The client ID isn't secret. This flow never uses the client secret, so leave it out of both apps.

### How sign-in works

This follows Google's [Sign In With Google for web](https://developers.google.com/identity/gsi/web/guides/overview) guidance:

1. The frontend loads `https://accounts.google.com/gsi/client` and shows the Google button and/or One Tap.
2. Google hands the frontend's `callback` an **ID token** (`response.credential`).
3. The frontend sends it to `POST /api/auth/google`.
4. The API [verifies the token](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token) with `google-auth-library`. That checks the signature against Google's keys, the audience (your client ID), the issuer and the expiry. The API also requires a verified email.
5. The user is identified by Google's `sub` (stable for life), not by email. Their first sign-in creates the account, so sign up and sign in are the same step.
6. The API returns its own session token (a JWT, valid for `JWT_EXPIRES_IN`). The frontend sends it as `Authorization: Bearer <token>`.

Frontend sketch:

```ts
// After <script src="https://accounts.google.com/gsi/client" async></script> has loaded
google.accounts.id.initialize({
  client_id: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID!,
  use_fedcm_for_button: true,
  callback: async ({ credential }) => {
    const res = await fetch(`${API_URL}/api/auth/google`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential }),
    });
    if (!res.ok) return showError((await res.json()).error);
    const { token, user } = await res.json();
    saveSession(token, user); // e.g. localStorage
  },
});
google.accounts.id.renderButton(document.getElementById("google-button")!, { theme: "outline", size: "large" });
google.accounts.id.prompt(); // One Tap (optional)

// Sign out: forget the token, and stop Google from signing straight back in
function signOut() {
  clearSession();
  google.accounts.id.disableAutoSelect();
}
```

When any call returns **401**, clear the stored token and show the Google button again.

## Connecting the frontend

This maps every screen and action in the frontend to the API, replacing `lib/store.ts`:

| Screen / action in the frontend | API call |
| --- | --- |
| Sign in / sign up | `POST /api/auth/google` |
| **Dashboard**: greeting, Safe to Spend card, budget status, the three stat tiles, recent activity, "Where your money went", evening reminder | `GET /api/dashboard` (one request) |
| Dashboard: invitation popup | `invitations` in `GET /api/dashboard`, or `GET /api/invitations` |
| No budget yet (new user) | `budget: null` in any of the above, so show a setup form that calls `POST /api/budget` |
| **Expenses**: history | `GET /api/transactions` |
| Expenses: All / Expenses / Income toggle | `?type=all\|expense\|income` |
| Expenses: category filter | `?category=food` (ignored when `type=income`, as in the UI) |
| Expenses: "12 entries · ₦9,050 spent · ₦5,000 received" | `totals` in the response |
| Expenses: "No transactions yet" vs "Nothing matches these filters" | `periodCount` is 0 vs `totals.count` is 0 |
| Expenses: search box or date filter (optional, not in the UI yet) | `?search=keke`, `?from=…&to=…` |
| Add expense / Add income | `POST /api/transactions`. Use `summary` from the response for the toast ("You can spend ₦X more today") |
| Edit / delete a transaction | `PUT` / `DELETE /api/transactions/:id` |
| **Analytics**: "This budget period" / "Last 7 days", stat tiles, per-day chart and table, by category, "What stands out" | `GET /api/analytics?range=period\|week` |
| **Roommate Kitty**: whole page | `GET /api/room` |
| Add / delete shared expense | `POST /api/room/expenses`, `DELETE /api/room/expenses/:id` |
| Mark as paid / Confirm received / Not received | `POST /api/room/settlements`, `…/:id/confirm`, `…/:id/decline` |
| Invite a roommate by email, cancel an invite, rename or leave the room | `POST /api/room/invites`, `DELETE /api/room/invites/:id`, `PATCH /api/room`, `POST /api/room/leave` |
| Accept / decline an invitation | `POST /api/invitations/:id/accept` / `decline` |
| **Settings**: budget period form | `PUT /api/budget` |
| Settings: Start a new period | `POST /api/budget` |
| Settings: evening reminder switch and time; "I'm all done" | `PATCH /api/me/reminder` |
| Settings: Demo data → Load | `POST /api/budget/demo` |

The frontend's calculation files keep working on API data. You can also use the server's `summary`, `balances` and `transfers` directly, because they follow the same rules:

- `lib/budget-calculations.ts` is mirrored by `src/modules/insights/insights.calculations.js`.
- `lib/roommate-calculations.ts` is mirrored by `src/modules/room/room.calculations.js`.

## API

Base URL: `http://localhost:4000`. Everything under `/api` except `/api/auth/google` needs `Authorization: Bearer <token>`.

### Conventions

- Amounts are **whole naira** integers from 1 to 10,000,000, the same as the frontend's `parseAmount`. Calculated figures such as `dailyGuide` and `dailyAverage` can be fractional. Round them for display, as `formatNaira` does.
- Dates are `YYYY-MM-DD`. "Today" is in `APP_TIMEZONE` (default `Africa/Lagos`). Responses that depend on it include `today`, so the frontend can use the same date.
- Ids are UUID strings.
- **Lists are newest first**: latest date, then most recently added. Each item has `createdAt`. Show them in the order given. You don't need `sortByRecent` any more, and running it on already-sorted data would flip entries that share a date.
- Errors look like `{ "error": "Message to show", "details": { "field": "Problem" } }`. `details` is only present on 400s from forms and filters, so you can show `error` in a popup and `details` next to fields.

| Status | Meaning |
| --- | --- |
| 400 | Invalid input (see `details`) |
| 401 | Not signed in, or the session expired: sign in with Google again |
| 403 | Signed in, but this action belongs to someone else (for example, only the recipient can confirm a payment) |
| 404 | Not found, or not yours |
| 409 | Not possible right now (for example, there's no budget yet, or the balance isn't settled) |

### Auth and profile

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| POST | `/api/auth/google` | `{ credential }` | `{ token, user }` |
| GET | `/api/me` | | `{ user, reminder }` |
| PATCH | `/api/me/reminder` | any of `{ enabled, time: "21:00", dismissedOn: "YYYY-MM-DD" \| null }` | `{ reminder }` |

- `user` is `{ id, name, email, avatarUrl }`.
- `reminder` is `{ enabled, time, dismissedOn }`. Changing `time` clears `dismissedOn`, as the frontend did.
- The frontend decides when to show the evening check-in: when `enabled` is true, `dismissedOn` isn't today, and the local clock has passed `time`.

### The budget summary

Several responses include `summary`: the Safe to Spend figures. It's the same object as the frontend's `BudgetSummary`, so the existing dashboard cards can use it unchanged.

| Field | Meaning |
| --- | --- |
| `totalSpent`, `totalIncome` | Totals for the current period |
| `remaining` | Starting money + extra income − expenses. Negative when overspent |
| `daysRemaining` | Days to the next income, counting today but not the income date. 0 means the period has ended |
| `dailyGuide` | Safe to spend today: money available before today's spending ÷ `daysRemaining`. It stays fixed through the day |
| `spentToday`, `leftToday` | Spent today, and `dailyGuide − spentToday`. Negative once today's guide is passed. The big number on the card is `max(0, leftToday)` |
| `guideFromTomorrow` | Set once today's guide is passed: the new suggested daily amount for the days after today. Otherwise `null` |
| `evenSpread` | What's left ÷ `daysRemaining`: the Survival Mode "aim for about ₦X per day" |
| `pace` | `{ kind: "no-history" }` or `{ kind: "estimated", averageDaily, windowDays, daysMoneyLasts }`, based on the last 7 complete days |
| `status` | `on-track`, `survival`, `overspent`, `period-ended` or `no-history` |

### Dashboard

`GET /api/dashboard` returns everything the dashboard shows in one request:

```jsonc
{
  "today": "2026-11-15",
  "user": { "id", "name", "email", "avatarUrl" },   // "Hi, {name}"
  "reminder": { "enabled", "time", "dismissedOn" },
  "budget": { "id", "label", "startingAmount", "startDate", "nextIncomeDate" },  // null before setup
  "summary": { … },                                  // see above; null before setup
  "recentTransactions": [ … ],                       // up to 5, newest first
  "categories": [{ "category", "total", "count", "share" }],  // this period, biggest first
  "invitations": [ … ]                               // pending room invitations, for the popup
}
```

### Budget

Every budget response is `{ today, budget, summary }`, recalculated after the change.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/api/budget` | | `budget` and `summary` are `null` until set up |
| POST | `/api/budget` | `{ label, startingAmount, nextIncomeDate, startDate? }` | `201` |
| PUT | `/api/budget` | `{ label, startingAmount, startDate, nextIncomeDate }` | `200` |
| POST | `/api/budget/demo` | `{ scenario: "on-track" \| "survival" }` | `201`, plus `transactions` |

`budget` matches the frontend's `Budget` type plus an `id`.

- **POST** is used for both first-time setup and "Start a new period".
  - `startDate` defaults to today and can't be in the future. `nextIncomeDate` must be after today.
  - The previous period is kept in the database, but its transactions no longer appear anywhere.
- **PUT** edits the current period. `startDate` can't be in the future and `nextIncomeDate` must be after `startDate`. An income date that has already passed is allowed: `summary.status` becomes `period-ended`.
- **POST /demo** loads the frontend's sample stories as a new period:
  - `on-track`: ₦27,750 left with 15 days to go, so ₦1,850 a day.
  - `survival`: ₦6,000 left with 9 days to go, at about ₦1,500 a day.

  It only replaces your personal budget. Roommate Kitty is shared with real people, so it isn't touched.

### Transactions (current period only)

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/api/transactions?…filters` | | `{ transactions, totals, periodCount }` |
| GET | `/api/transactions/:id` | | `{ transaction }` |
| POST | `/api/transactions` | a draft (below) | `201 { transaction, summary }` |
| PUT | `/api/transactions/:id` | a draft | `{ transaction, summary }` |
| DELETE | `/api/transactions/:id` | | `{ summary }` |

A draft is one of:

- `{ type: "expense", amount, category, date, note? }`
- `{ type: "income", amount, date, note? }`

`category` is a frontend `CategoryId`: `food`, `transport`, `printing`, `data`, `personal-care`, `giving`, `outings` or `others`. `note` has at most 60 characters. `date` must be between the period's start and today. A transaction comes back with `id` and `createdAt`; income has no `category`.

**Filters.** All of these are optional query parameters, and can be combined:

| Parameter | Effect |
| --- | --- |
| `type` | `all` (default), `expense` or `income` |
| `category` | `all` (default) or a category id. Only matches expenses, and is ignored when `type=income`, like the Expenses page |
| `search` | Case-insensitive text found in the note **or** the category name (`airtime` finds "Data & airtime" expenses) |
| `from`, `to` | Date range, inclusive |
| `limit`, `offset` | Paging: `limit` is 1–500, `offset` defaults to 0. Without `limit` you get the whole period |

The response:

```jsonc
{
  "transactions": [ … ],                                // the matching page, newest first
  "totals": { "count": 12, "spent": 9050, "received": 5000 },  // every match, ignoring limit/offset
  "periodCount": 30                                     // all transactions this period, ignoring filters
}
```

### Analytics

`GET /api/analytics?range=period|week` (default `period`). `period` runs from the budget start to today. `week` is the last 7 days including today, but never before the budget started. Without a budget it returns 409.

```jsonc
{
  "today": "2026-11-15", "range": "period", "from": "2026-10-31", "to": "2026-11-15",
  "dayCount": 16,
  "totalSpent": 12250, "expenseCount": 18,
  "dailyAverage": 765.625,                                    // totalSpent ÷ dayCount
  "topCategory": { "category", "total", "count", "share" },   // null when nothing was spent
  "highestDay": { "date", "total" },                          // null when nothing was spent
  "categories": [{ "category", "total", "count", "share" }],  // biggest first; share is 0–1
  "days": [{ "date", "total" }],                              // every day from → to, oldest first, zeros included
  "summary": { … }                                            // for "What stands out", which compares the average with dailyGuide
}
```

`categories`, `days`, `dailyAverage` and `summary` are exactly what the frontend's `buildObservations` takes, so the plain-language observations can stay in the frontend.

### Roommate Kitty: your room

Every change responds with the **whole updated room**, because one change can move everyone's balances. Replace your room state with it.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/api/room` | | `{ room }` (`null` if you're not in one) |
| PATCH | `/api/room` | `{ name }` | `{ room }` |
| POST | `/api/room/invites` | `{ email }` | `201 { room }` |
| DELETE | `/api/room/invites/:id` | | `{ room }` |
| POST | `/api/room/expenses` | `{ description, amount, date, paidBy, splitWith }` | `201 { room }` |
| DELETE | `/api/room/expenses/:id` | | `{ room }` |
| POST | `/api/room/settlements` | `{ to, amount? }` | `201 { room }` |
| POST | `/api/room/settlements/:id/confirm` | | `{ room }` |
| POST | `/api/room/settlements/:id/decline` | | `{ room }` |
| POST | `/api/room/leave` | | `{ room: null }` |

The `room` object:

```jsonc
{
  "id": "…",
  "name": "Room 14, Unity Lodge",
  "currentMemberId": "…",           // the signed-in user
  "members": [{ "id", "name", "avatarUrl", "hasLeft" }],  // room order; people who left stay for history
  "invites": [{ "id", "email", "invitedBy", "createdAt" }],  // pending invites sent from this room
  "sharedExpenses": [{ "id", "description", "amount", "date", "paidBy", "createdBy", "createdAt",
                       "splitWith": ["memberId"], "shares": [{ "memberId", "amount" }] }],
  "settlements": [{ "id", "from", "to", "amount", "status", "markedPaidOn", "confirmedOn", "declinedOn", "createdAt" }],
  "balances": [{ "memberId", "paid", "share", "sent", "received", "net" }],  // net > 0: is owed money
  "transfers": [{ "from", "to", "amount" }]                                // who should pay whom
}
```

`members`, `sharedExpenses` and `settlements` match the frontend's `Room`, `SharedExpense` and `Settlement` types. `sharedExpenses`, `settlements` and `invites` are newest first. `balances` and `transfers` are worked out by the server with the same rules as `lib/roommate-calculations.ts`, so the frontend can show them directly. Settlement `status` is `awaiting-confirmation`, `confirmed` or `declined`. Existing frontend code already ignores `declined`.

In the "Add shared expense" dialog, list only members where `hasLeft` is false.

#### Rules the server enforces

- **Invites.** Enter a roommate's email. Your first invite creates your room, named "{first name}'s room"; rename it with `PATCH /api/room`. The invitee doesn't need an account yet: the invite waits until they sign in with Google using that email. Inviting the same email twice is harmless. Any member can cancel a pending invite.
- **Shared expenses.** `paidBy` and everyone in `splitWith` must be current members. The cost is split equally in whole naira. Leftover naira go one each to the earliest members (₦10,000 ÷ 3 = ₦3,334 + ₦3,333 + ₦3,333). Each person's share is stored with the expense, so later membership changes never rewrite old splits. Only the person who added an expense, or the person who paid for it, can delete it.
- **Settling up.** No money moves through Stretch.
  - Only the debtor can mark a payment as paid, and only to someone in their `transfers`. `amount` defaults to the full amount owed, and smaller (partial) amounts are allowed.
  - There can be only one payment awaiting confirmation per pair.
  - Only the recipient can confirm or decline. Balances change only after they confirm.
- **Leaving.** You can leave only when your `net` is 0 and no payment involving you is waiting. When the last member leaves, the room and its history are deleted. One person is in at most one room.
- **Privacy.** Room responses never include anyone's personal budget or transactions.

### Roommate Kitty: invitations you've received

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/invitations` | `{ invitations: [{ id, room: { id, name, memberCount }, invitedBy: { name, avatarUrl }, createdAt }] }` |
| POST | `/api/invitations/:id/accept` | `{ room }` |
| POST | `/api/invitations/:id/decline` | `204` |

There are no push or email notifications. Show a popup when `invitations` (from `GET /api/dashboard` or `GET /api/invitations`) isn't empty.

Accepting while you're alone in your own room closes that room and joins you to the new one. If you share a room with others, accepting returns 409 until you leave that room.

## Deploying

- Set the same environment variables on your host. `CORS_ORIGIN` must list your deployed frontend URL.
- Run `npm run db:migrate` on each deploy, before `npm start`.
- Encrypt the database connection. **Supabase** signs its certificates with its own root CA, so `?sslmode=require` fails with `SELF_SIGNED_CERT_IN_CHAIN`. Instead, download the CA certificate (Project Settings → Database → SSL configuration), save it as `certs/supabase-ca.crt`, and append `?sslmode=verify-full&sslrootcert=certs/supabase-ca.crt` to `DATABASE_URL`.
- On Supabase, migration `002` turns on row-level security, so Supabase's public Data API can't read the tables. Keep it on: this server is the only intended way in.
- Add the deployed frontend URL to the Google client's **Authorized JavaScript origins**.
