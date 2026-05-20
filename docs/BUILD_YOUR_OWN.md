# Build your own FrameCAD

FrameCAD was written for FRC Team 2129, but the team-specific bits live
in a handful of build-time environment variables. Forking and shipping
your own team's distribution takes maybe an hour.

This doc covers what you'll need to change. The result is an installer
that auto-fills your team's defaults on every machine it lands on, plus
a place for auto-bug-reports to flow that isn't upstream's tracker.

## Quickstart

1. Fork [netarcx/FrameCAD](https://github.com/netarcx/FrameCAD) on
   GitHub.
2. In your fork's settings, add the four Actions secrets below.
3. Edit two lines of `electron-builder.yml` to point auto-update at
   your fork.
4. Push to `main` — CI builds a Windows / Linux installer with your
   team's defaults baked in.

That's it. The rest of this doc explains each step.

## Required: build-time secrets

Set these as **repository secrets** under
`Settings → Secrets and variables → Actions` in your fork. CI passes
them to the Vite build as `process.env.*`, and they're inlined as
string literals in the compiled bundle.

| Secret | Example | What it does |
|---|---|---|
| `FRAMECAD_DEFAULT_GITHUB_ORG` | `frc1234` | Default GitHub org the welcome screen "Browse Projects" wizard searches. |
| `FRAMECAD_DEFAULT_PROJECT_PREFIX` | `1234` or `26-1234` | Default part-number prefix. If you supply just the team segment, FrameCAD prepends the current 2-digit year on every new project. |
| `FRAMECAD_DEFAULT_TEAM_NAME` | `FRC Team 1234 — Acme` | Shown in the welcome subtitle and on every auto-generated project README. |
| `FRAMECAD_DEFAULT_WELCOME_MESSAGE` | `Cut metal, not corners.` | Optional banner copy under the welcome subtitle. |
| `FRAMECAD_DEFAULT_ISSUE_REPO` | `frc1234/FrameCAD` | Where the in-app **Report to GitHub** button files auto-reports. Falls back to `netarcx/FrameCAD` if unset, which floods upstream — set this. |

The Settings page lets every install override any of these per-machine,
but the build-time defaults are what new installs see before anyone
opens Settings.

## Required: redirect auto-update

The Windows / Linux builds auto-update from GitHub Releases. Out of
the box, that's `netarcx/FrameCAD/releases` — your fork needs its own
release feed.

Edit `electron-builder.yml`:

```yaml
publish:
  provider: github
  owner: YOUR-GITHUB-USERNAME
  repo: YOUR-FORK-REPO-NAME
  releaseType: release
```

After this change every push to `main` in your fork builds an installer
and uploads it as a release under your fork. Existing installs of
**your** fork will start auto-updating from there; they won't get
upstream's releases.

## Optional: app identity

If you want students to see your team's name in the title bar, taskbar,
and Add/Remove Programs list, change `electron-builder.yml`:

```yaml
appId: com.yourteam.framecad   # upstream uses com.trentcad.app for update-chain compat
productName: YourTeamCAD       # was FrameCAD
```

Note that changing `appId` and `productName` means your build installs
**alongside** an existing FrameCAD install instead of upgrading it.
That's usually what you want for a fork.

## Optional: branding

For a fuller rebrand:

| File | What it controls |
|---|---|
| `build/icon.png` | Installer + window icon (1024×1024 PNG) |
| `src/renderer/src/assets/logo.png` | In-app logo (top-left + welcome screen) |
| `solidworks-addin/FrameCAD.SolidWorksAddin/logo.png` | SW add-in pane icon |
| `solidworks-addin/FrameCAD.SolidWorksAddin/taskpane-icon.bmp` | SW task-pane tab icon (16×18 BMP) |
| `README.md` / `CHANGELOG.md` | Project-level docs |

A handful of strings still reference "FrameCAD" in code comments and
the OnboardingTour — those are cosmetic and you can grep-replace at
leisure. Nothing functional reads them.

## Things upstream owns

- The `framecad://` URL scheme. If you fork and want your own scheme
  (`yourteamcad://join?url=…`) you'll need to update
  `electron-builder.yml` `protocols:` plus `src/main/index.ts`
  `setAsDefaultProtocolClient` / `parseFrameCADUrl`.
- The on-disk REST API port `42129`. Change `FRAMECAD_API_PORT` env or
  the `DEFAULT_PORT` constant in `src/main/rest.ts` if you want to
  avoid colliding with someone running an upstream FrameCAD on the
  same machine.

## Test locally before pushing

```bash
FRAMECAD_DEFAULT_GITHUB_ORG=frc1234 \
FRAMECAD_DEFAULT_PROJECT_PREFIX=1234 \
FRAMECAD_DEFAULT_TEAM_NAME="FRC Team 1234" \
FRAMECAD_DEFAULT_ISSUE_REPO=frc1234/FrameCAD \
  npm run dev
```

The welcome screen subtitle and the wizard placeholders should reflect
your values immediately.

## Questions?

If your team is rolling out a fork and hits a wall, open an issue on
upstream and we'll take a look. Especially interested in feedback that
exposes more team-specific assumptions still hiding in the code.
