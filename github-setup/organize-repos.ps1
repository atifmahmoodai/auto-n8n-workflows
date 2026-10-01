# Windows version of organize-repos.sh
# Requires GitHub CLI:  winget install --id GitHub.cli   (then close and reopen the terminal)
# One-time:  gh auth login ;  gh auth refresh -s delete_repo
# Usage (from this folder):
#   powershell -ExecutionPolicy Bypass -File organize-repos.ps1           (dry run, prints commands)
#   powershell -ExecutionPolicy Bypass -File organize-repos.ps1 -Apply    (actually runs them)
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$U = 'atifmahmoodai'

function Run {
  Write-Host ("+ " + ($args -join ' '))
  if ($Apply) {
    $exe = $args[0]; $rest = @($args | Select-Object -Skip 1)
    & $exe @rest
    if ($LASTEXITCODE -ne 0) { throw "Command failed (exit $LASTEXITCODE): $($args -join ' ')" }
  }
}

if ($Apply -and -not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "gh not found. Run: winget install --id GitHub.cli   then reopen the terminal."
}

# Descriptions for repos that have none (before renames)
$desc = [ordered]@{
  'car-rental-fleet'        = 'Car rental fleet management web app'
  'garage-workshop-manager' = 'Garage workshop job cards, parts and billing'
  'dealer-price-tracker'    = 'Track and compare dealer car prices'
  'claude-auto-showroom'    = 'Online auto showroom web app'
  'showroom-manager'        = 'Showroom management software'
  'claude_cloud'            = 'Collection of 96 n8n automation workflows, sorted by category'
}
foreach ($r in $desc.Keys) { Run gh repo edit "$U/$r" --description $desc[$r] }

# old-name, new-name, topic
$map = @(
  @('enquiry-sales-dashboard',       'data-enquiry-sales-dashboard',       'data-analyst'),
  @('dealership-financials-powerbi', 'data-dealership-financials-powerbi', 'data-analyst'),
  @('used-car-price-estimator',      'data-used-car-price-estimator',      'data-analyst'),
  @('Email-Backup',                  'auto-email-backup-n8n',              'automation'),
  @('dealership-automation',         'auto-dealership-listings',           'automation'),
  @('claude_cloud',                  'auto-n8n-workflows',                 'automation'),
  @('automotive-marketplace',        'web-automotive-marketplace',         'web-app'),
  @('car-rental-fleet',              'web-car-rental-fleet',               'web-app'),
  @('dealer-price-tracker',          'web-dealer-price-tracker',           'web-app'),
  @('claude-auto-showroom',          'web-auto-showroom',                  'web-app'),
  @('atifs-vault',                   'web-atifs-vault-3d-museum',          'web-app'),
  @('Astra',                         'web-astra',                          'web-app'),
  @('motorcycle-fleet-garage',       'mobile-motorcycle-fleet-garage',     'mobile-app'),
  @('dealer-management-system',      'soft-dealer-management-system',      'software'),
  @('garage-workshop-manager',       'soft-garage-workshop-manager',       'software'),
  @('showroom-manager',              'soft-showroom-manager',              'software'),
  @('Claude-Skill',                  'soft-claude-plan-first-skill',       'software'),
  @('foison',                        'client-foison',                      'client-work')
)
foreach ($m in $map) {
  Run gh repo edit "$U/$($m[0])" --add-topic $m[2]
  Run gh repo rename $m[1] --repo "$U/$($m[0])" --yes
}

# Empty placeholder repos: verified zero commits and zero files (2026-10-01)
foreach ($r in 'web-apps','power-bi','lovable') { Run gh repo delete "$U/$r" --yes }

# Profile README repo
$exists = $false
if ($Apply) {
  # Windows PowerShell 5.1 turns native stderr into a terminating error under 'Stop'
  $ErrorActionPreference = 'Continue'
  gh repo view "$U/$U" *> $null
  $exists = ($LASTEXITCODE -eq 0)
  $ErrorActionPreference = 'Stop'
}
if ($exists) { Write-Host "Profile repo already exists, skipping create" }
else { Run gh repo create "$U/$U" --public --description "Profile README" }
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("profile-" + [guid]::NewGuid())
Run gh repo clone "$U/$U" $tmp
if ($Apply) {
  Copy-Item (Join-Path $PSScriptRoot 'PROFILE-README.md') (Join-Path $tmp 'README.md') -Force
  Run git -C $tmp add README.md
  Run git -C $tmp commit -m "Add profile README organized by category"
  Run git -C $tmp push -u origin HEAD:main
} else { Write-Host "+ copy PROFILE-README.md to README.md, commit and push to $U/$U" }
Write-Host "Done."
