# Firebase credentials on the server

Customer auth runs through Firebase Identity Platform: `POST /v1/auth/signup`
calls `getAuth().createUser()`, and password sign-in goes through the Identity
Toolkit REST API. Two different credentials are involved, and confusing them is
the usual cause of a half-working login.

| Credential | Used for | Secret? | Where it lives |
|---|---|---|---|
| Service-account key | Admin SDK — `createUser`, `verifyIdToken` | **YES** | `serviceAccountKey.json`, bind-mounted |
| `FIREBASE_API_KEY` | Identity Toolkit REST — password sign-in, reset emails | No | `.env` |

Set only the service account and signup succeeds while **sign-in** fails with
`FIREBASE_API_KEY is required for password authentication`. Both are needed.

## How the key is delivered

`src/config/firebase.ts` resolves credentials in three tiers:

1. `FIREBASE_SERVICE_ACCOUNT_JSON` — the key JSON inline
2. `FIREBASE_SERVICE_ACCOUNT_PATH` — an explicit path
3. **`serviceAccountKey.json` in the working directory**

We use tier 3, and set **neither environment variable**. The container's
`WORKDIR` is `/app`, so `docker-compose.prod.yml` bind-mounts the file there:

```yaml
volumes:
  - ./serviceAccountKey.json:/app/serviceAccountKey.json:ro
```

One code path then works identically on a dev box (cwd is the repo root, where
the file already is) and in the container. Nothing Firebase-related needs to be
in `.env` except the public API key.

### Why not the other two tiers

**Not inline in `.env`.** A 2 KB private key in the same file as the database
password and the Razorpay secret means every tool, log, paste and editor that
touches `.env` handles the key too. That is not theoretical — it is how the key
leaked, twice.

**Not `COPY`ed into the image.** Every Docker layer is readable by anyone who can
pull the image, and the key survives in the build cache and any registry it
reaches. If someone proposes `COPY serviceAccountKey.json ./` in the Dockerfile,
this is the paragraph to point at.

## Deploying

Put the key file next to `docker-compose.prod.yml` on the server — transfer it
over SSH, never by pasting it into a terminal or chat:

```bash
scp -i <key.pem> serviceAccountKey.json <user>@<host>:/path/to/Back-End/
```

Lock it down and restart:

```bash
chmod 600 serviceAccountKey.json
```

```bash
docker compose -f docker-compose.prod.yml up -d --force-recreate api worker
```

Confirm — credentials resolve lazily and log only on failure, so silence is
success:

```bash
docker compose -f docker-compose.prod.yml logs --tail=40 api | grep -i firebase
```

Then create a throwaway account on the live site.

## Firebase console checklist

**Delete every superseded service-account key.** Generating a new key does not
revoke the old one. Project settings → Service accounts → Manage service account
keys. Both `468289cb5f5ace…` and `9ba79629ce37e8…` were exposed and must not
remain valid — delete them *after* the replacement key is deployed and verified.

**Authentication → Sign-in method:** enable **Email/Password** and **Google**.

**Authentication → Settings → Authorised domains:** add `achichiz.com` and any
preview domain. Without it Google sign-in fails with `auth/unauthorized-domain`,
which the storefront now reports in plain language rather than as a generic
failure.

## Verifying locally

```bash
npx tsx --env-file=.env -e "import('./src/config/firebase.js').then(m => console.log(m.getFirebaseApp().name))"
```

`tsx` silently ignores `-e` on some versions and exits 0 — if you get no output,
put the snippet in a file and run that instead rather than reading the empty
success as a pass.
