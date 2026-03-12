# MXReset

Self-hosted password reset portal for organizations using [MXRoute](https://mxroute.com) custom domain email. Since MXRoute does not provide a native self-service password reset flow, this app lets you offer one to your members.

## How it works

1. A user visits the app and enters their custom domain email address.
2. If the email is registered, a reset link is sent to their pre-configured **recovery email**.
3. The user clicks the link, sets a new password, and the app calls the MXRoute API to apply the change.

All reset tokens are short-lived (15 minutes), stored as SHA-256 hashes, and recovery emails are encrypted at rest using AES-256-CBC.

---

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/yourname/mxreset.git
cd mxreset
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in all values. See the section below for details.

### 4. Generate the admin password hash

```bash
node -e "const b=require('bcrypt');b.hash('yourpassword',12).then(console.log)"
```

Copy the output into `ADMIN_PASSWORD_HASH` in your `.env`.

### 5. Run the database migration

On first run (or after schema changes):

```bash
mkdir -p data
npx prisma migrate dev --name init
```

This creates the SQLite database at `data/db.sqlite`.

### 6. Start the server

```bash
npm start
```

The app will be available at `http://localhost:3000`.

---

## Running with Docker

### Build the image

```bash
docker build -t mxreset .
```

### Run the container

```bash
docker run -d \
  --name mxreset \
  -p 3000:3000 \
  --env-file .env \
  -v $(pwd)/data:/app/data \
  mxreset
```

The `-v $(pwd)/data:/app/data` mount persists the SQLite database across container restarts.

### Run the migration inside the container

On first run, execute the migration:

```bash
docker exec mxreset npx prisma migrate deploy
```

---

## Environment variables

| Variable | Description |
|---|---|
| `ADMIN_PASSWORD_HASH` | bcrypt hash of the admin password (cost factor 12 recommended) |
| `SESSION_SECRET` | Long random string used to sign session cookies |
| `ENCRYPTION_KEY` | Exactly 32 characters — used for AES-256-CBC encryption of recovery emails |
| `MXROUTE_API_KEY` | Your MXRoute API key |
| `MXROUTE_SERVER` | Your MXRoute server identifier |
| `MXROUTE_USERNAME` | Your MXRoute username |
| `SMTP_HOST` | SMTP hostname (e.g. `mail.mxroute.com`) |
| `SMTP_PORT` | SMTP port (default: `587`) |
| `SMTP_USER` | SMTP username / sender address |
| `SMTP_PASS` | SMTP password |
| `BASE_URL` | Public URL of this app, no trailing slash (e.g. `https://reset.yourdomain.com`) |
| `PORT` | Port to listen on (default: `3000`) |

---

## HTTPS in production

It is strongly recommended to run mxreset behind a reverse proxy that handles TLS. [Caddy](https://caddyserver.com) is an easy choice — it automatically provisions and renews HTTPS certificates.

Example `Caddyfile`:

```
reset.yourdomain.com {
    reverse_proxy localhost:3000
}
```

---

## CSV import format

The admin dashboard supports bulk user import via CSV. The file must have a header row with exactly these two columns:

```
email,recoveryEmail
hassan@customdomain.com,hassan@gmail.com
alice@customdomain.com,alice@proton.me
```

- **email** — the MXRoute custom domain email address
- **recoveryEmail** — the external address where the reset link will be sent

Duplicate emails are skipped silently. Rows that fail validation are listed in the import summary.

---

## MXRoute API integration

The password update call is in [src/services/mxroute.js](src/services/mxroute.js). It sends a `PATCH` request to `https://api.mxroute.com/domains/{domain}/email-accounts/{user}` using the `MXROUTE_API_KEY`, `MXROUTE_SERVER`, and `MXROUTE_USERNAME` credentials from your `.env`.

---

## License

ISC
