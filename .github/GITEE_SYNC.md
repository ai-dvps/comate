# Gitee mirror automation

The `Sync to Gitee` GitHub Actions workflow mirrors this repository to
`https://gitee.com/ai-dvps/comate` for users who have slow access to GitHub.

## One-time setup

1. Create a Gitee personal access token for a service account that can create
   repositories in the `ai-dvps` organization, push branches and tags, and
   manage Releases and their attachments.
2. Create a GitHub Actions Environment named `gitee-mirror`. Limit its
   deployment branches and tags to the default branch and the Release tag
   pattern (normally `v*`). Add the token to that Environment, not as a
   repository-level secret, with the name `GITEE_TOKEN`. This prevents workflow
   code from an arbitrary feature branch from receiving the organization token.
3. If the destination should differ from `ai-dvps/<GitHub repository name>`,
   add Actions variables named `GITEE_OWNER` and/or `GITEE_REPO`.
4. Run the `Sync to Gitee` workflow manually once to bootstrap the mirror. Leave
   `release_tag` empty when only branches and tags need reconciliation. Enter an
   existing published tag such as `v0.4.4` to backfill that Release's metadata
   and every attachment as part of the same run.

The workflow creates the Gitee repository automatically when it does not yet
exist. The service account must be allowed to force-update and delete mirrored
branches/tags; otherwise pruning a deleted or rewritten GitHub ref will fail.

## What is synchronized

- Main-branch pushes, Release tags, and ref deletions are mirrored immediately.
  An hourly trusted reconciliation mirrors every branch and tag and prunes
  Gitee-only refs, so feature branches converge without exposing the Gitee
  token to workflow code from those branches.
- A GitHub Release is synchronized only after it is published. Draft Releases
  stay private on GitHub and are never exposed early on Gitee. Unpublishing or
  deleting a GitHub Release removes the corresponding Gitee Release. Existing
  published Releases can be synchronized on demand with the manual
  `release_tag` input.
- Release title, notes, prerelease state, and every attached installer/update
  file (`.dmg`, `.exe`, `.AppImage`, `.deb`, manifests, blockmaps, and archives)
  are copied to the matching Gitee Release.
- Re-running the workflow is safe: attachments are replaced conservatively
  because Gitee does not expose a trustworthy content digest, duplicates are
  removed, stale attachments are deleted, and the final remote name/size set is
  verified. This also preserves updater manifests such as `latest.yml`.

GitHub remains the release source of truth and the desktop auto-updater still
uses GitHub Releases. Gitee is a download mirror, so publishing or editing a
release on Gitee directly is not supported and will be overwritten by the next
sync.
