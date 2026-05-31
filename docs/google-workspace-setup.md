# Google Workspace Setup for FrameCAD

One-time setup by a team mentor/admin. Takes about 10 minutes.

## What you need

- Admin access to your team's Google Workspace (the `@yourdomain.org` account)
- Google Workspace for Nonprofits (free for 501(c)(3) — includes 100 TB Shared Drive storage)

## Step 1: Create a Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Sign in with your Workspace admin account
3. Click the project dropdown at the top (next to "Google Cloud")
4. Click **New Project**
5. Name it `FrameCAD` (or whatever you like)
6. Leave the organization as-is
7. Click **Create**, then select it from the dropdown

No billing account is needed. If prompted, you can skip/dismiss it.

## Step 2: Enable the Google Drive API

1. In the left sidebar, go to **APIs & Services > Library**
2. Search for **Google Drive API**
3. Click it, then click **Enable**

## Step 3: Configure the OAuth consent screen

Google has been migrating this UI. You'll see either:
- **Google Auth Platform > Branding** (new layout), or
- **APIs & Services > OAuth consent screen** (legacy layout)

Both work the same way.

### Choose user type

Select **Internal**.

This restricts sign-in to your Workspace domain only — students with `@yourdomain.org` accounts can sign in, nobody else can. No app verification needed, no scary "unverified app" warning.

### Fill in app info

| Field | Value |
|-------|-------|
| App name | `FrameCAD` |
| User support email | Your admin email |
| Developer contact email | Your admin email |

Skip everything else (logo, homepage, privacy policy — not needed for Internal apps).

Click **Save and Continue**.

### Add scopes

1. Click **Add or Remove Scopes**
2. Search for `Google Drive API`
3. Check the box for `https://www.googleapis.com/auth/drive`
4. Click **Update**, then **Save and Continue**

If using the new "Google Auth Platform" UI, scopes are under **Data Access** instead.

## Step 4: Create OAuth credentials

1. Go to **APIs & Services > Credentials** (or **Google Auth Platform > Clients**)
2. Click **+ Create Credentials > OAuth client ID**
3. Application type: **Desktop app**
4. Name: `FrameCAD Desktop`
5. Click **Create**

## Step 5: Save your credentials

A dialog appears with your **Client ID** and **Client Secret**.

**Download the JSON immediately** — Google masks the secret after this screen. If you lose it, you'll need to create a new client.

The Client ID looks like: `123456789-xxxxxxxx.apps.googleusercontent.com`
The Client Secret looks like: `GOCSPX-xxxxxxxxxxxxxxxx`

## Step 6: Create a Shared Drive

1. Go to [drive.google.com](https://drive.google.com)
2. In the left sidebar, click **Shared drives**
3. Click **+ New** (or right-click > New shared drive)
4. Name it (e.g., `FRC 2129 CAD`)
5. Add team members with **Contributor** access (or **Content manager** for leads)

This Shared Drive is where all CAD projects will live. Each project gets its own folder.

## Step 7: Configure FrameCAD

### Dev (recommended): a `.env` file

Copy `.env.example` (at the repo root) to `.env` and fill in your values:

```
GOOGLE_CLIENT_ID=your-client-id-here.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-your-secret-here
FRAMECAD_GOOGLE_SHARED_DRIVE_IDS=0AExampleSharedDriveId
```

`.env` is gitignored and loaded automatically at startup (`src/main/load-env.ts`),
so `npm run dev` picks it up — you don't have to re-export anything in each shell.
`FRAMECAD_GOOGLE_SHARED_DRIVE_IDS` is optional for dev, but production builds
should set it to the Shared Drive ID that contains FrameCAD projects. Multiple
IDs can be comma-separated.

### Or: shell environment variables

If you'd rather not use a file, export them before running FrameCAD (a real
`export` takes precedence over `.env`):

```bash
export GOOGLE_CLIENT_ID="your-client-id-here.apps.googleusercontent.com"
export GOOGLE_CLIENT_SECRET="GOCSPX-your-secret-here"
export FRAMECAD_GOOGLE_SHARED_DRIVE_IDS="0AExampleSharedDriveId"
```

On Windows (PowerShell):
```powershell
$env:GOOGLE_CLIENT_ID = "your-client-id-here.apps.googleusercontent.com"
$env:GOOGLE_CLIENT_SECRET = "GOCSPX-your-secret-here"
$env:FRAMECAD_GOOGLE_SHARED_DRIVE_IDS = "0AExampleSharedDriveId"
```

For GitHub Actions installer builds, add repository secrets named
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and
`FRAMECAD_GOOGLE_SHARED_DRIVE_IDS`. Those values are embedded in the app binary
so students do not need to set them. Enrolled clients can also receive the
Shared Drive allowlist from the team server: open the server admin UI and set
**Team Settings → Google Drive → Allowed Shared Drive IDs**. The server value
wins when it is non-empty; the installer value is the fallback.

## Things to know

**Storage:** Your nonprofit Workspace includes 100 TB of Shared Drive storage. More than enough for CAD files.

**API quotas:** The free tier allows 2,400 requests per user per minute. Normal FrameCAD usage won't come close to this.

**OAuth client inactivity:** Google auto-deletes OAuth clients that are inactive for 6 months. If no one uses FrameCAD over summer break, you may need to recreate the credentials in Step 4.

**Domain-only access:** Because you chose "Internal", only `@yourdomain.org` accounts can sign in. Personal Gmail accounts are blocked. This is intentional — only team members should have access.
