# Page Smart Solutions

Business site and admin for an IT and smart home side business: public homepage with services and contact form, plus a private admin for customers, jobs, invoices, expenses with receipts, mileage, and a federal tax estimate.

## Run locally
    npm install
    npm start
Open http://localhost:3000 and http://localhost:3000/admin (local password: `dev`). With no `DATABASE_URL` it uses a local file database in `.localdb`.

## Deploy on Railway
1. Push this repo to GitHub.
2. Railway: New Project, Deploy from GitHub repo, pick this repo.
3. In the project, New, Database, Add PostgreSQL.
4. On the web service, Variables: add `DATABASE_URL` as a reference to the Postgres service's `DATABASE_URL`, plus `ADMIN_PASSWORD` and `SESSION_SECRET`.
5. Settings, Networking, Generate Domain. Sign in at `/admin`.

Optional: `RESEND_API_KEY`, `NOTIFY_EMAIL`, `NOTIFY_FROM` for email alerts on contact form messages.

## Team accounts and roles
The first time the server starts it creates one admin account with username `admin` and your `ADMIN_PASSWORD`. Sign in with those, then open Team to add people (and rename yourself).
- Admin: everything, including settings, taxes, expenses, mileage and the team.
- Accounting: price changes, invoices (including saved ones), jobs, customers and the calendar.
- Employee: add jobs, update client info and see the calendar. Only sees jobs assigned to them, and no prices, invoices or money.

`ADMIN_PASSWORD` always opens the first admin account, so you can recover if you forget your own password. The role rules live in one table, `CAPS` and `RULES`, at the top of the auth section in `server.js`.

## First setup in the admin
Settings: phone, email, home address, sales tax rate. Financial: salary and federal withholding.

## Test
    npm test

The tax page is an estimate for planning, not tax advice.
