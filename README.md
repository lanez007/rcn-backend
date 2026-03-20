# RCN Apply — Backend

Express + Postgres backend for the RCN Group application landing page.
Receives lead submissions, stores them in Postgres, sends email notifications,
and serves a password-protected admin dashboard.

---

## Deploy to Railway (step by step)

### 1. Create a new Railway project
- Go to railway.app → New Project → Deploy from GitHub repo
- Push this folder to a GitHub repo first, then connect it

### 2. Add a Postgres database
- In your Railway project: + New → Database → PostgreSQL
- Railway will auto-set DATABASE_URL in your environment

### 3. Set environment variables
In Railway → your service → Variables, add:

| Key | Value |
|-----|-------|
| `DATABASE_URL` | Auto-set by Railway Postgres plugin |
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | your Gmail address |
| `SMTP_PASS` | Gmail App Password (see below) |
| `NOTIFY_EMAIL` | email that receives lead alerts |
| `ADMIN_USER` | your chosen admin username |
| `ADMIN_PASS` | your chosen admin password |

### 4. Gmail App Password setup
1. Go to myaccount.google.com
2. Security → 2-Step Verification (must be enabled)
3. App Passwords → Generate → name it "RCN Backend"
4. Copy the 16-character password → paste as SMTP_PASS

### 5. Get your Railway URL
After deploy, Railway gives you a URL like:
`https://rcn-apply-backend-production.up.railway.app`

### 6. Update the landing page
In `rcn-apply.html`, replace:
```
const ENDPOINT = 'https://YOUR_WEBHOOK_OR_BACKEND_URL_HERE';
```
with:
```
const ENDPOINT = 'https://your-railway-url.up.railway.app/apply';
```

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Health check |
| POST | `/apply` | Receive form submission |
| GET | `/admin` | Lead dashboard (password protected) |

## Admin Dashboard
Visit `https://your-railway-url.up.railway.app/admin` in your browser.
Enter the ADMIN_USER and ADMIN_PASS when prompted.

Shows: total leads, today's count, credit score 650+ count, this week's count,
and a full table of all applications newest-first.

---

## Local development
```bash
npm install
cp .env.example .env   # fill in your values
npm run dev
```
