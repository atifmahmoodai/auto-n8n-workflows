#!/usr/bin/env bash
# Organize atifmahmoodai's repos by category: rename with prefix, add topic, flag empties.
# Requires GitHub CLI: https://cli.github.com  ->  gh auth login
# Usage: bash organize-repos.sh            (dry run, prints commands)
#        bash organize-repos.sh --apply    (actually runs them)
set -euo pipefail
U=atifmahmoodai
APPLY=${1:-}
run() { echo "+ $*"; [[ "$APPLY" == "--apply" ]] && "$@" || true; }

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

echo
echo "Empty placeholder repos (web-apps, power-bi, lovable): check them, then delete manually:"
echo "  gh repo delete $U/web-apps --yes; gh repo delete $U/power-bi --yes; gh repo delete $U/lovable --yes"
echo "(needs: gh auth refresh -s delete_repo)"
