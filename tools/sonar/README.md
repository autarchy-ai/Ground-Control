# Sonar configuration artifacts

Canonical store for SonarCloud configuration captured from Ground Control and
sibling repos. Add new Sonar-related artifacts here so every Sonar config a
Ground Control engineer needs is in one place.

The scanner config (`sonar-project.properties`) stays at the repository root
because the Sonar scanner reads it from there. Everything else, including
quality profile backups, custom-rule definitions, and any future tooling
artifacts, lives under this directory.

## Layout

- `profiles/`: quality profile XML backups exported via
  `GET /api/qualityprofiles/backup`. One file per profile per capture date.
- `assert_no_new_issues.py`: CI guard that queries SonarCloud after scanner
  completion and fails the job when the current pull request or branch has
  any open issue in the new-code leak period.

## New-issue gate

The CI `sonar` job runs the SonarCloud scan and quality-gate check, then runs
`tools/sonar/assert_no_new_issues.py`. The script uses `SONAR_TOKEN` only for
SonarCloud API authentication, derives the pull request number from the GitHub
event payload, and prints only issue metadata when it fails. Pass
`--organization` with an organization token: SonarCloud refuses that token's
issue search without the organization (HTTP 400). This keeps the
repo-side merge gate stricter than a SonarCloud project gate that may still
allow non-blocking code smells.

## File naming

Profile backups use `<language>__<profile-name>__<org-key>__<YYYY-MM-DD>.xml`.
The org segment identifies the SonarCloud organization the profile was
captured from; two orgs can hold profiles with the same name and language,
and the org segment keeps them distinct. The date is the capture date, not a
release date. Adding a new snapshot does not replace prior captures; both
coexist so changes to a profile remain auditable.

## Capturing a new snapshot

Export the live profile from SonarCloud (requires `SONAR_TOKEN` in the
environment):

```bash
curl -s -u "$SONAR_TOKEN:" -G \
  "https://sonarcloud.io/api/qualityprofiles/backup" \
  --data-urlencode "organization=<org>" \
  --data-urlencode "language=<lang>" \
  --data-urlencode "qualityProfile=<name>" \
  -o "tools/sonar/profiles/<lang>__<name>__<org>__$(date +%F).xml"
```

## Restoring a profile into another project

Upload the XML to the target SonarCloud organization via
`POST /api/qualityprofiles/restore`, then attach it to a project with
`POST /api/qualityprofiles/add_project`, or mark it as the organization
default for the language. The captured `<language>__<profile-name>` pair in
the filename matches what SonarCloud expects in the restore payload.
