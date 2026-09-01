# Email delivery (Gmail / Google Workspace over SMTP)

Password resets and staff invites are the only things that use this today. Both
produce a one-time token and a link to `/reset-password`; without a working
sender the token is created and the mail is dropped, which is exactly what
happened for the whole life of the project before this was wired up.

## Why SMTP and not SES

SES was the original plan and `createSesEmailSender()` was never implemented — it
threw on every send. Worse, the selection rule keyed off `AWS_ACCESS_KEY_ID`,
which exists for S3 media uploads, so *having* AWS credentials chose the broken
sender. Callers swallow send failures on purpose (a mail outage must not reveal
which accounts exist), so nothing surfaced.

Delivery is now chosen by the **mail** credentials themselves: set
`SMTP_USER` + `SMTP_PASSWORD` and real mail is sent; leave them unset and the
no-op sender logs instead. AWS keys no longer influence it.

## Setup

### 1. Turn on 2-Step Verification

Google will not issue an app password without it.
`myaccount.google.com` → **Security** → **2-Step Verification**.

### 2. Create an app password

`myaccount.google.com` → **Security** → **2-Step Verification** → **App
passwords**. Name it something like `achichiz-api`. You get 16 characters.

Use this, **not** the account password — Google rejects account passwords for
SMTP, and an app password can be revoked on its own without changing your login.

### 3. Set the environment

Add to `.env` on the server (`docker-compose.prod.yml` already passes the whole
file through via `env_file`):

```
SMTP_USER=founder@achichiz.in
SMTP_PASSWORD=<the 16-character app password>
EMAIL_FROM=Achichiz <founder@achichiz.in>
```

`SMTP_HOST` and `SMTP_PORT` default to `smtp.gmail.com:465` and only need
setting if you are moving off Gmail.

> **`EMAIL_FROM` must be `SMTP_USER` or an alias that mailbox owns.** Gmail
> silently rewrites a `From` it does not recognise, so mail appears to send and
> arrives from the wrong address.

### 4. Restart and confirm

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs api | grep -i "email delivery"
```

You want `email delivery enabled over SMTP`. If you see
`EMAIL IS NOT DELIVERED`, the credentials did not reach the process.

### 5. Send a real test

```bash
npx tsx --env-file=.env qa/10-email-diagnose.ts you@example.com
```

This calls the real sender and prints whatever it throws — which is the detail
the password-reset flow deliberately hides. It sends to the address you give it
and nowhere else.

## When it fails

| Symptom | Cause |
|---|---|
| `EAUTH` / `535 Username and Password not accepted` | Account password used instead of an app password, or 2-Step Verification is off |
| `ETIMEDOUT` / `ECONNREFUSED` | Outbound 465 blocked — common on cloud hosts. Try `SMTP_PORT=587` (the code switches to STARTTLS automatically) |
| Sends fine, never arrives | Check spam. Then check `EMAIL_FROM` matches `SMTP_USER` |
| `EMAIL IS NOT DELIVERED` at boot | `SMTP_USER` / `SMTP_PASSWORD` not set in the running container |

## Limits

A consumer Gmail account allows roughly **500 recipients/day**; Workspace about
**2,000**. Fine for password resets and staff invites. Order confirmations at
volume would need a real ESP.

**Do not send marketing through this sender.** A complaint spike on a shared
sender poisons transactional deliverability — keep campaigns on a separate
domain with its own reputation.
