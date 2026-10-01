#!/usr/bin/env bash
# Organize atifmahmoodai's repos by category: rename with prefix, add topic, flag empties.
# Requires GitHub CLI: https://cli.github.com  ->  gh auth login
# One-time: gh auth refresh -s delete_repo   (needed to delete repos)
# Usage: bash organize-repos.sh            (dry run, prints commands)
#        bash organize-repos.sh --apply    (actually runs them)
set -euo pipefail
U=atifmahmoodai
APPLY=${1:-}
run() {
  echo "+ $*"
  if [[ "$APPLY" == "--apply" ]]; then "$@"; fi
}

# Descriptions for repos that have none (runs before renames)
run gh repo edit "$U/car-rental-fleet"        --description "Car rental fleet management web app"
run gh repo edit "$U/garage-workshop-manager" --description "Garage workshop job cards, parts and billing"
run gh repo edit "$U/dealer-price-tracker"    --description "Track and compare dealer car prices"
run gh repo edit "$U/claude-auto-showroom"    --description "Online auto showroom web app"
run gh repo edit "$U/showroom-manager"        --description "Showroom management software"
run gh repo edit "$U/claude_cloud"            --description "Collection of 96 n8n automation workflows, sorted by category"

# old-name  new-name  topic
while read -r old new topic; do
  [[ -z "$old" || "$old" == \#* ]] && continue
  run gh repo edit "$U/$old" --add-topic "$topic"
  if [[ "$old" != "$new" ]]; then
    run gh repo rename "$new" --repo "$U/$old" --yes
  fi
done <<'MAP'
# --- Data Analyst ---
enquiry-sales-dashboard        data-enquiry-sales-dashboard        data-analyst
dealership-financials-powerbi  data-dealership-financials-powerbi  data-analyst
used-car-price-estimator       data-used-car-price-estimator       data-analyst
# --- Automation ---
Email-Backup                   auto-email-backup-n8n               automation
dealership-automation          auto-dealership-listings            automation
claude_cloud                   auto-n8n-workflows                  automation
# --- Web Apps ---
automotive-marketplace         web-automotive-marketplace          web-app
car-rental-fleet               web-car-rental-fleet                web-app
dealer-price-tracker           web-dealer-price-tracker            web-app
claude-auto-showroom           web-auto-showroom                   web-app
atifs-vault                    web-atifs-vault-3d-museum           web-app
Astra                          web-astra                           web-app
# --- Mobile Apps ---
motorcycle-fleet-garage        mobile-motorcycle-fleet-garage      mobile-app
# --- Software ---
dealer-management-system       soft-dealer-management-system       software
garage-workshop-manager        soft-garage-workshop-manager        software
showroom-manager               soft-showroom-manager               software
Claude-Skill                   soft-claude-plan-first-skill        software
# --- Client Solutions ---
foison                         client-foison                       client-work
MAP


# Empty placeholder repos: verified to have zero commits and zero files (2026-10-01)
for r in web-apps power-bi lovable; do
  run gh repo delete "$U/$r" --yes
done

# Profile README repo (shows on github.com/atifmahmoodai)
HERE="$(cd "$(dirname "$0")" && pwd)"
if [[ "$APPLY" == "--apply" ]] && gh repo view "$U/$U" >/dev/null 2>&1; then
  echo "Profile repo already exists, skipping create"
else
  run gh repo create "$U/$U" --public --description "Profile README"
fi
TMP="$(mktemp -d)"
run gh repo clone "$U/$U" "$TMP/profile"
if [[ "$APPLY" == "--apply" ]]; then
  cp "$HERE/PROFILE-README.md" "$TMP/profile/README.md"
  git -C "$TMP/profile" add README.md
  git -C "$TMP/profile" commit -m "Add profile README organized by category"
  git -C "$TMP/profile" push -u origin HEAD:main
else
  echo "+ copy PROFILE-README.md to README.md, commit and push to $U/$U"
fi
echo "Done."
