#!/usr/bin/env bash
set -euo pipefail

# Prefer the current origin; fall back to the project repository.
DEFAULT_URL="$(git remote get-url origin 2>/dev/null || true)"
if [ -z "$DEFAULT_URL" ]; then
  DEFAULT_URL="https://github.com/jincocodev/openclaw-jarvis-ui.git"
fi

echo "🔄 Preparing to publish this project to GitHub..."
echo -n "Enter your new GitHub repository URL [default: $DEFAULT_URL]: "
read -r NEW_URL

if [ -z "$NEW_URL" ]; then
  NEW_URL="$DEFAULT_URL"
fi

echo ""
echo "Target repository: $NEW_URL"
echo "This script will commit local changes, back up the remote main branch if it exists,"
echo "then publish this project to main using --force-with-lease."
echo -n "Type PUBLISH to continue: "
read -r CONFIRM
if [ "$CONFIRM" != "PUBLISH" ]; then
  echo "Aborted. Nothing was changed."
  exit 0
fi

# Clean up temporary remote if it exists
git remote remove temp_dest 2>/dev/null || true

echo "📥 Fetching current remote repository info to check for existing files..."
git remote add temp_dest "$NEW_URL"
if git fetch temp_dest; then
  # Check if main branch exists in the remote repository
  if git show-ref --verify --quiet refs/remotes/temp_dest/main; then
    BACKUP_BRANCH="backup-website-$(date +%Y%m%d-%H%M%S)"
    echo "⚠️  Found existing 'main' branch in remote. Backing it up to '$BACKUP_BRANCH'..."
    if git push temp_dest refs/remotes/temp_dest/main:refs/heads/"$BACKUP_BRANCH"; then
      echo "✅ Successfully backed up the old website to branch: '$BACKUP_BRANCH'"
    else
      echo "❌ Failed to create backup branch on remote. Please check if you have write permissions to the repository."
      git remote remove temp_dest 2>/dev/null
      exit 1
    fi
  else
    echo "ℹ️  No existing 'main' branch found in remote repository. No backup needed."
  fi
else
  echo "❌ Failed to fetch from remote repository. Please make sure the repository exists and you have access."
  git remote remove temp_dest 2>/dev/null
  exit 1
fi

# Clean up temp remote
git remote remove temp_dest 2>/dev/null

# Update origin remote
echo "⚙️  Updating git 'origin' to: $NEW_URL"
git remote set-url origin "$NEW_URL" 2>/dev/null || git remote add origin "$NEW_URL"

# Commit local changes if any
echo "💾 Checking for local changes to commit..."
git add -A
if ! git diff --cached --quiet; then
  git commit -m "Publish OpenClaw Jarvis UI updates"
else
  echo "ℹ️  No new local changes to commit."
fi

# Force push to replace the main branch
echo "📦 Pushing this project to 'main' branch..."
git branch -M main
git fetch origin main
if git push -u origin main --force-with-lease; then
  echo "🎉 Done! Your codebase has been pushed to the new repository's 'main' branch."
  echo "💡 The previous remote main is safe in the backup branch printed above."
else
  echo "❌ Push failed. If this is a credentials/login issue, please run this script directly in your terminal to complete GitHub authentication."
  exit 1
fi
